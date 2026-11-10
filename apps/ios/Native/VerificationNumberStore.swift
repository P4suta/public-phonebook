#if PHONEBOOK_VERIFICATION_TOOLS
  import Foundation
  import PhonebookCore

  /// Keeps the QA build's test number in the App Group container, where the Call Directory extension reads it.
  /// The file stays on this device: the app excludes it from backups and never logs or sends it.
  enum VerificationNumberStore {
    static let fileName = "verification-number.json"
    static let callerProbeFileName = "verification-caller-held.callers"

    enum Failure: Error, Equatable { case missingDirectory, insufficientCallerEntries }

    /// The app and the extension each read the App Group from their own Info.plist, because the extension compiles this file alone.
    static func container() throws -> URL {
      guard
        let group = Bundle.main.object(forInfoDictionaryKey: "PhonebookAppGroup") as? String,
        let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
      else { throw CocoaError(.fileNoSuchFile) }
      return root
    }

    private static func url() throws -> URL {
      try container().appendingPathComponent(fileName)
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

    static func prepareCallerProbe(in root: URL) throws -> URL {
      guard let active = try CallerFile.active(in: root.appendingPathComponent("Directory")) else {
        throw Failure.missingDirectory
      }
      let reader = try CallerFile.Reader(url: active.file)
      var entries: [(Int64, String)] = []
      _ = try reader.read(upTo: 1001) { number, label in
        entries.append(
          (number, label == "QA held comparison" ? "QA held alternate" : "QA held comparison"))
      }
      guard entries.count == 1001 else { throw Failure.insufficientCallerEntries }
      let temporary = root.appendingPathComponent(UUID().uuidString + ".callers")
      defer { try? FileManager.default.removeItem(at: temporary) }
      let writer = try CallerFile.Writer(url: temporary)
      for (number, label) in entries { try writer.append(number: number, label: label) }
      try writer.finish()
      var temporaryURL = temporary
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try temporaryURL.setResourceValues(values)
      try FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
        ofItemAtPath: temporary.path)
      try clearCallerProbe(in: root)
      let pending = root.appendingPathComponent(callerProbeFileName)
      try FileManager.default.moveItem(at: temporary, to: pending)
      return pending
    }

    static func takeCallerProbe(in root: URL) throws -> URL? {
      let pending = root.appendingPathComponent(callerProbeFileName)
      guard FileManager.default.fileExists(atPath: pending.path) else { return nil }
      let consumed = root.appendingPathComponent("used-\(UUID().uuidString)-\(callerProbeFileName)")
      try FileManager.default.moveItem(at: pending, to: consumed)
      return consumed
    }

    static func clearCallerProbe(in root: URL) throws {
      let pending = root.appendingPathComponent(callerProbeFileName)
      if FileManager.default.fileExists(atPath: pending.path) {
        try FileManager.default.removeItem(at: pending)
      }
    }
  }
#endif
