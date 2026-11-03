#if PHONEBOOK_VERIFICATION_TOOLS
  import Foundation
  import PhonebookCore

  /// Keeps the QA build's test number in the App Group container, where the Call Directory extension reads it.
  /// The file stays on this device: the app excludes it from backups and never logs or sends it.
  enum VerificationNumberStore {
    static let fileName = "verification-number.json"

    /// The app and the extension each read the App Group from their own Info.plist, because the extension compiles this file alone.
    private static func url() throws -> URL {
      guard
        let group = Bundle.main.object(forInfoDictionaryKey: "PhonebookAppGroup") as? String,
        let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
      else { throw CocoaError(.fileNoSuchFile) }
      return root.appendingPathComponent(fileName)
    }

    /// The saved entry, or nil when none is saved or the saved file fails the entry's checks.
    static func load() -> CallerEntry? {
      guard let url = try? url(), let data = try? Data(contentsOf: url) else { return nil }
      return try? JSONDecoder().decode(CallerEntry.self, from: data)
    }

    static func save(_ entry: CallerEntry) throws {
      var url = try url()
      // The extension loads caller names while the phone is locked after its first unlock.
      try JSONEncoder().encode(entry).write(
        to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try url.setResourceValues(values)
    }

    static func clear() throws {
      let url = try url()
      guard FileManager.default.fileExists(atPath: url.path) else { return }
      try FileManager.default.removeItem(at: url)
    }
  }
#endif
