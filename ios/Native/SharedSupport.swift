import Foundation
import OSLog
import PhonebookCore
import PhonebookKit

enum AppIdentity {
  static var displayName: String {
    Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "Public Phonebook"
  }

  static var apiOrigin: String {
    #if DEBUG
      if let local = ProcessInfo.processInfo.environment["PHONEBOOK_API_ORIGIN"] { return local }
    #endif
    return Bundle.main.object(forInfoDictionaryKey: "PhonebookAPIOrigin") as? String
      ?? "https://www.dial.page"
  }

  static var appGroup: String {
    Bundle.main.object(forInfoDictionaryKey: "PhonebookAppGroup") as? String
      ?? "group.page.dial.publicphonebook"
  }

  static var callDirectory: String {
    Bundle.main.object(forInfoDictionaryKey: "PhonebookCallDirectory") as? String
      ?? "page.dial.publicphonebook.CallDirectory"
  }

  static var backgroundRefresh: String {
    Bundle.main.object(forInfoDictionaryKey: "PhonebookBackgroundRefresh") as? String
      ?? "page.dial.publicphonebook.refresh"
  }

  static func store() throws -> SnapshotStore {
    guard
      let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    else {
      throw ImportError.unavailableStorage
    }
    return try SnapshotStore(
      root: root.appendingPathComponent("Directory", isDirectory: true), trace: SystemTraceSink())
  }
}

struct SystemTraceSink: TraceSink {
  private let logger = Logger(subsystem: "page.dial.publicphonebook", category: "directory")
  func record(_ event: TraceEvent) {
    logger.info(
      "operation=\(event.operation.uuidString, privacy: .public) phase=\(event.phase.rawValue, privacy: .public) outcome=\(event.outcome.rawValue, privacy: .public) snapshot=\(event.snapshot?.rawValue ?? "none", privacy: .public) records=\(event.records ?? 0, privacy: .public)"
    )
  }
}

enum WebAddress {
  /// Returns an http or https URL with a host and no credentials, which the app may open.
  static func url(_ text: String) -> URL? {
    guard let url = URL(string: text), ["http", "https"].contains(url.scheme),
      url.host != nil, url.user == nil, url.password == nil
    else { return nil }
    return url
  }
}
