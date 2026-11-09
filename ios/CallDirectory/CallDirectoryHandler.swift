import CallKit
import Foundation
import PhonebookCore

#if PHONEBOOK_VERIFICATION_TOOLS
  import Darwin
  import OSLog
#endif

/// Streams the caller file into CallKit within the extension's 12 MB memory limit.
///
/// The request runs synchronously with only Foundation, CallKit, and the caller file reader, so no database, actor, or task stays in memory.
final class CallDirectoryHandler: CXCallDirectoryProvider, CXCallDirectoryExtensionContextDelegate {
  #if PHONEBOOK_VERIFICATION_TOOLS
    private let logger = Logger(subsystem: "page.dial.publicphonebook", category: "caller")
    private let signposter = OSSignposter(
      subsystem: "page.dial.publicphonebook", category: "caller")
  #endif

  override func beginRequest(with context: CXCallDirectoryExtensionContext) {
    context.delegate = self
    #if PHONEBOOK_VERIFICATION_TOOLS
      let signpost = signposter.makeSignpostID()
      let interval = signposter.beginInterval("load", id: signpost)
      defer { signposter.endInterval("load", interval) }
    #endif
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
      #if PHONEBOOK_VERIFICATION_TOOLS
        var peak = Self.footprint()
      #else
        let peak: UInt64 = 0
      #endif
      let incremental = context.isIncremental
      var held = incremental ? Self.held(in: directory) : nil
      #if PHONEBOOK_VERIFICATION_TOOLS
        let probe = try VerificationNumberStore.takeCallerProbe(
          in: VerificationNumberStore.container())
        defer {
          if let probe {
            do { try FileManager.default.removeItem(at: probe) } catch {
              let failure = error as NSError
              logger.error(
                "caller.probe result=cleanup_failed domain=\(failure.domain, privacy: .public) code=\(failure.code, privacy: .public)"
              )
            }
          }
        }
        if incremental, let probe {
          held = { try CallerFile.Merged(national: CallerFile.Reader(url: probe), extra: nil) }
        }
      #endif
      let plan = try CallerFile.load(
        held: held, wanted: wanted,
        removeAll: { if incremental { context.removeAllIdentificationEntries() } },
        remove: { number in
          context.removeIdentificationEntry(withPhoneNumber: number)
          removed += 1
          if removed % 1000 == 0 {
            #if PHONEBOOK_VERIFICATION_TOOLS
              peak = max(peak, Self.footprint())
              logger.debug(
                "caller.load phase=remove removed=\(removed, privacy: .public) footprintKB=\(peak / 1024, privacy: .public)"
              )
            #endif
          }
        },
        add: { number, label in
          context.addIdentificationEntry(withNextSequentialPhoneNumber: number, label: label)
          entries += 1
          if entries % 50_000 == 0 {
            #if PHONEBOOK_VERIFICATION_TOOLS
              signposter.emitEvent("batch", id: signpost)
              peak = max(peak, Self.footprint())
              logger.debug(
                "caller.load entries=\(entries, privacy: .public) footprintKB=\(peak / 1024, privacy: .public)"
              )
            #endif
          }
        })
      #if PHONEBOOK_VERIFICATION_TOOLS
        logger.debug("caller.load plan=\(plan.rawValue, privacy: .public)")
      #endif
      complete(
        context, entries: entries, removed: removed, peak: max(peak, Self.footprint()),
        incremental: incremental, plan: plan,
        loaded: target, in: directory)
    } catch {
      #if PHONEBOOK_VERIFICATION_TOOLS
        let failure = error as NSError
        logger.error(
          "caller.load result=failed domain=\(failure.domain, privacy: .public) code=\(failure.code, privacy: .public) description=\(failure.localizedDescription, privacy: .private)"
        )
      #endif
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

  /// Records the loaded generation only after iOS takes the entries.
  private func complete(
    _ context: CXCallDirectoryExtensionContext, entries: Int, removed: Int, peak: UInt64,
    incremental: Bool, plan: CallerLoadPlan,
    loaded: CallerFile.Loaded, in directory: URL
  ) {
    #if PHONEBOOK_VERIFICATION_TOOLS
      let logger = logger
    #endif
    context.completeRequest { expired in
      #if PHONEBOOK_VERIFICATION_TOOLS
        logger.notice(
          "caller.load result=\(expired ? "expired" : "complete", privacy: .public) entries=\(entries, privacy: .public) removed=\(removed, privacy: .public) peakFootprintKB=\(peak / 1024, privacy: .public) incremental=\(incremental, privacy: .public) plan=\(plan.rawValue, privacy: .public)"
        )
      #endif
      // The app reads this record and skips asking iOS to load the same generation again, and the next load sends the difference from it.
      guard !expired else { return }
      try? CallerFile.recordLoaded(loaded, in: directory)
    }
  }

  func requestFailed(
    for extensionContext: CXCallDirectoryExtensionContext, withError error: any Error
  ) {
    #if PHONEBOOK_VERIFICATION_TOOLS
      let failure = error as NSError
      logger.error(
        "caller.request result=failed domain=\(failure.domain, privacy: .public) code=\(failure.code, privacy: .public) description=\(failure.localizedDescription, privacy: .private)"
      )
    #endif
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
    #if PHONEBOOK_VERIFICATION_TOOLS
      var info = task_vm_info_data_t()
      var count = mach_msg_type_number_t(
        MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
      let result = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
          task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
        }
      }
      return result == KERN_SUCCESS ? info.phys_footprint : 0
    #else
      return 0
    #endif
  }
}
