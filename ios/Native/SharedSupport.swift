import Foundation
import OSLog
import PhonebookCore
import PhonebookKit
import Synchronization

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

  static var backgroundCheck: String {
    Bundle.main.object(forInfoDictionaryKey: "PhonebookBackgroundCheck") as? String
      ?? "page.dial.publicphonebook.check"
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

  static func synchronizer(api: APIClient, store: SnapshotStore) -> SyncEngine {
    #if PHONEBOOK_VERIFICATION_TOOLS
      var directory = Bundle.main.resourceURL
      #if DEBUG
        if let entry = ProcessInfo.processInfo.environment["PHONEBOOK_BUNDLED_ENTRY"] {
          directory = URL(fileURLWithPath: entry).deletingLastPathComponent()
        }
      #endif
      return SyncEngine(
        api: api, store: store, trace: SystemTraceSink(),
        searchArtifacts: SearchArtifactRepository(api: api, bundledDirectory: directory))
    #else
      return SyncEngine(api: api, store: store, trace: SystemTraceSink())
    #endif
  }
}

struct SystemTraceSink: TraceSink {
  private let logger = Logger(subsystem: "page.dial.publicphonebook", category: "directory")
  /// Instruments shows these intervals and points in the `os_signpost` instrument, as Apple's guide to recording performance data describes.
  private static let signposter = OSSignposter(
    subsystem: "page.dial.publicphonebook", category: "directory")
  private static let intervals = Mutex(TraceIntervals<OSSignpostIntervalState>())

  func record(_ event: TraceEvent) {
    logger.info(
      "operation=\(event.operation.uuidString, privacy: .public) phase=\(event.phase.rawValue, privacy: .public) outcome=\(event.outcome.rawValue, privacy: .public) snapshot=\(event.snapshot?.rawValue ?? "none", privacy: .public) records=\(event.records ?? 0, privacy: .public) milliseconds=\(event.milliseconds.map(String.init) ?? "none", privacy: .public)"
    )
    let signposter = Self.signposter
    Self.intervals.withLock {
      $0.record(
        event,
        begin: { key in
          signposter.beginInterval(
            "phase", id: signposter.makeSignpostID(), "\(key.phase.rawValue, privacy: .public)")
        },
        end: { _, state in
          signposter.endInterval("phase", state, "\(event.outcome.rawValue, privacy: .public)")
        },
        mark: { point in
          signposter.emitEvent(
            "point",
            "\(point.phase.rawValue, privacy: .public) milliseconds=\(point.milliseconds.map(String.init) ?? "none", privacy: .public)"
          )
        })
    }
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
