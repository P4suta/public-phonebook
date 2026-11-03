import CallKit
import Darwin
import Foundation
import OSLog
import PhonebookCore

/// Streams the caller file into CallKit within the extension's 12 MB memory limit.
///
/// The request runs synchronously with only Foundation, CallKit, and the caller file reader, so no database, actor, or task stays in memory.
final class CallDirectoryHandler: CXCallDirectoryProvider {
  private let logger = Logger(subsystem: "page.dial.publicphonebook", category: "caller")

  override func beginRequest(with context: CXCallDirectoryExtensionContext) {
    do {
      if context.isIncremental { context.removeAllIdentificationEntries() }
      let directory = try Self.directory()
      let active = try CallerFile.active(in: directory)
      #if PHONEBOOK_VERIFICATION_TOOLS
        let extra = VerificationNumberStore.load()
      #else
        let extra: CallerEntry? = nil
      #endif
      guard active != nil || extra != nil else {
        // Turning the extension on before the first save succeeds with no entries.
        logger.notice("caller.load entries=0 reason=unsaved")
        context.completeRequest()
        return
      }
      let reader = try CallerFile.Merged(
        national: active.map { try CallerFile.Reader(url: $0.file) }, extra: extra)
      var entries = 0
      var peak = Self.footprint()
      while true {
        let read = try autoreleasepool {
          try reader.read(upTo: 1000) { number, label in
            context.addIdentificationEntry(withNextSequentialPhoneNumber: number, label: label)
          }
        }
        guard read > 0 else { break }
        entries += read
        if entries % 50_000 < read {
          peak = max(peak, Self.footprint())
          logger.notice(
            "caller.load entries=\(entries, privacy: .public) footprintKB=\(peak / 1024, privacy: .public)"
          )
        }
      }
      logger.notice(
        "caller.load entries=\(entries, privacy: .public) peakFootprintKB=\(max(peak, Self.footprint()) / 1024, privacy: .public) result=complete"
      )
      let generation = active?.generation
      context.completeRequest { expired in
        // The app reads this record and skips asking iOS to load the same generation again.
        guard !expired, let generation else { return }
        try? CallerFile.recordLoaded(generation, in: directory)
      }
    } catch {
      logger.error("caller.load result=failed error=\(String(describing: error), privacy: .public)")
      context.cancelRequest(withError: error)
    }
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
