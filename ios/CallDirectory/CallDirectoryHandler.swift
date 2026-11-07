import CallKit
import Darwin
import Foundation
import OSLog
import PhonebookCore

/// Streams the caller file into CallKit within the extension's 12 MB memory limit.
///
/// The request runs synchronously with only Foundation, CallKit, and the caller file reader, so no database, actor, or task stays in memory.
final class CallDirectoryHandler: CXCallDirectoryProvider, CXCallDirectoryExtensionContextDelegate {
  private let logger = Logger(subsystem: "page.dial.publicphonebook", category: "caller")
  private let signposter = OSSignposter(subsystem: "page.dial.publicphonebook", category: "caller")

  override func beginRequest(with context: CXCallDirectoryExtensionContext) {
    context.delegate = self
    let signpost = signposter.makeSignpostID()
    let interval = signposter.beginInterval("load", id: signpost)
    defer { signposter.endInterval("load", interval) }
    do {
      let directory = try Self.directory()
      let active = try CallerFile.active(in: directory)
      #if PHONEBOOK_VERIFICATION_TOOLS
        let extra = VerificationNumberStore.load()
      #else
        let extra: CallerEntry? = nil
      #endif
      let target = CallerFile.Loaded(
        generation: active?.generation,
        extra: extra.map { CallerFile.Loaded.Extra(number: $0.phone.number, label: $0.label) })
      let wanted = {
        try CallerFile.Merged(
          national: active.map { try CallerFile.Reader(url: $0.file) }, loaded: target.extra)
      }
      var entries = 0
      var removed = 0
      var peak = Self.footprint()
      let incremental = context.isIncremental
      let plan = try CallerFile.load(
        held: incremental ? Self.held(in: directory) : nil, wanted: wanted,
        removeAll: { if incremental { context.removeAllIdentificationEntries() } },
        remove: { number in
          context.removeIdentificationEntry(withPhoneNumber: number)
          removed += 1
          if removed % 1000 == 0 {
            peak = max(peak, Self.footprint())
            logger.debug(
              "caller.load phase=remove removed=\(removed, privacy: .public) footprintKB=\(peak / 1024, privacy: .public)"
            )
          }
        },
        add: { number, label in
          context.addIdentificationEntry(withNextSequentialPhoneNumber: number, label: label)
          entries += 1
          if entries % 50_000 == 0 {
            signposter.emitEvent("batch", id: signpost)
            peak = max(peak, Self.footprint())
            logger.debug(
              "caller.load entries=\(entries, privacy: .public) footprintKB=\(peak / 1024, privacy: .public)"
            )
          }
        })
      logger.debug("caller.load plan=\(plan.rawValue, privacy: .public)")
      complete(
        context, entries: entries, removed: removed, peak: max(peak, Self.footprint()),
        loaded: target, in: directory)
    } catch {
      let failure = error as NSError
      logger.error(
        "caller.load result=failed domain=\(failure.domain, privacy: .public) code=\(failure.code, privacy: .public) description=\(failure.localizedDescription, privacy: .private)"
      )
      context.cancelRequest(withError: error)
    }
  }

  /// Opens what iOS holds as the loaded record names it, or returns nil when the record or its caller file is gone.
  private static func held(in directory: URL) -> (() throws -> CallerFile.Merged)? {
    guard let loaded = CallerFile.loaded(in: directory) else { return nil }
    switch CallerFile.held(loaded, in: directory) {
    case .none: return { CallerFile.Merged(national: nil, loaded: loaded.extra) }
    case .file(let file):
      return { CallerFile.Merged(national: try CallerFile.Reader(url: file), loaded: loaded.extra) }
    case .missing: return nil
    }
  }

  /// Logs one summary when iOS has taken the entries, because an expired request adds none of them.
  private func complete(
    _ context: CXCallDirectoryExtensionContext, entries: Int, removed: Int, peak: UInt64,
    loaded: CallerFile.Loaded, in directory: URL
  ) {
    let logger = logger
    context.completeRequest { expired in
      logger.notice(
        "caller.load result=\(expired ? "expired" : "complete", privacy: .public) entries=\(entries, privacy: .public) removed=\(removed, privacy: .public) peakFootprintKB=\(peak / 1024, privacy: .public)"
      )
      // The app reads this record and skips asking iOS to load the same generation again, and the next load sends the difference from it.
      guard !expired else { return }
      try? CallerFile.recordLoaded(loaded, in: directory)
    }
  }

  func requestFailed(
    for extensionContext: CXCallDirectoryExtensionContext, withError error: any Error
  ) {
    let failure = error as NSError
    logger.error(
      "caller.request result=failed domain=\(failure.domain, privacy: .public) code=\(failure.code, privacy: .public) description=\(failure.localizedDescription, privacy: .private)"
    )
  }

  private static func directory() throws -> URL {
    let group =
      Bundle.main.object(forInfoDictionaryKey: "PhonebookAppGroup") as? String
      ?? "group.page.dial.publicphonebook"
    guard let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
    else { throw CocoaError(.fileNoSuchFile) }
    return root.appendingPathComponent("Directory", isDirectory: true)
  }

  private static func footprint() -> UInt64 {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(
      MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let result = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
      }
    }
    return result == KERN_SUCCESS ? info.phys_footprint : 0
  }
}
