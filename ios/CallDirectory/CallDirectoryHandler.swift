import CallKit
import Foundation
import PhonebookKit

final class CallDirectoryHandler: CXCallDirectoryProvider {
  override func beginRequest(with context: CXCallDirectoryExtensionContext) {
    let request = DirectoryRequest(context: context)
    Task { await request.load() }
  }
}

// One task owns each framework request and performs its context calls sequentially.
private final class DirectoryRequest: @unchecked Sendable {
  private let context: CXCallDirectoryExtensionContext
  init(context: CXCallDirectoryExtensionContext) { self.context = context }

  func load() async {
    do {
      let store = try AppIdentity.store()
      if context.isIncremental { context.removeAllIdentificationEntries() }
      guard let manifest = try await store.manifest() else {
        // Turning the extension on before the first save succeeds with no entries.
        _ = await context.completeRequest()
        return
      }
      var previous: Int64 = 0
      while true {
        try Task.checkCancellation()
        let entries = try await store.identification(
          generation: manifest.generation, after: previous)
        guard !entries.isEmpty else { break }
        for entry in entries {
          guard entry.number > previous else { throw ImportError.invalidRecord }
          context.addIdentificationEntry(
            withNextSequentialPhoneNumber: entry.number, label: entry.label)
          previous = entry.number
        }
      }
      _ = await context.completeRequest()
    } catch { context.cancelRequest(withError: error) }
  }
}
