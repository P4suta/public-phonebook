import Foundation
import PhonebookCore

/// The generated entry beside the bundled archive, which repeats what the ready manifest states about it.
public struct BundledEntry: Codable, Sendable, Equatable {
  public let snapshot: SnapshotID
  public let generatedAt: String
  public let contacts: Int
  public let format: String
  public let bytes: Int
  public let sha256: SnapshotID

  public init(
    snapshot: SnapshotID, generatedAt: String, contacts: Int, format: String, bytes: Int,
    sha256: SnapshotID
  ) {
    self.snapshot = snapshot
    self.generatedAt = generatedAt
    self.contacts = contacts
    self.format = format
    self.bytes = bytes
    self.sha256 = sha256
  }

  /// The listed description of the archive, which staging compares with its header.
  var archive: DatasetArchive {
    DatasetArchive(snapshot: snapshot, contacts: contacts, link: "", sha256: sha256, bytes: bytes)
  }
}

/// The field of a bundled archive or its entry that differs from what the entry states.
public struct BundleMismatch: Error, Equatable, Sendable {
  public enum Field: String, Sendable, CaseIterable {
    case entry, format, bytes, sha256, header, snapshot, contacts, generatedAt, rows
  }

  public let field: Field
}

/// The directory archive that the app bundle carries, admitted with the checks of a download.
public struct BundledDataset: Sendable, Equatable {
  /// Larger than any entry that the build writes, so a damaged entry can't size a read.
  static let maximumEntryBytes = 4_096

  public let archive: URL
  public let entry: BundledEntry

  /// Checks the archive's length, SHA-256, format line, and header with its entry, without reading the rows.
  /// Staging reads the rows and checks their count, so a failure there also counts as an unreadable bundle.
  public static func open(archive: URL, entry: URL) async throws -> BundledDataset {
    let decoded: BundledEntry
    do {
      let handle = try FileHandle(forReadingFrom: entry)
      defer { try? handle.close() }
      let data = try handle.read(upToCount: maximumEntryBytes + 1) ?? Data()
      guard data.count <= maximumEntryBytes else { throw BundleMismatch(field: .entry) }
      decoded = try JSONDecoder().decode(BundledEntry.self, from: data)
    } catch {
      throw BundleMismatch(field: .entry)
    }
    try await admitHeader(archive: archive, entry: decoded)
    return BundledDataset(archive: archive, entry: decoded)
  }

  /// Checks everything that `open` checks and then every row, as the build does once before it bundles the archive.
  public static func admit(archive: URL, entry: BundledEntry) async throws {
    try await admitHeader(archive: archive, entry: entry)
    do {
      _ = try await DirectoryArchiveReader(url: archive).read(
        header: { _ in }, records: { _, _ in })
    } catch {
      throw BundleMismatch(field: .rows)
    }
  }

  private struct HeaderRead: Error {}

  private static func admitHeader(archive: URL, entry: BundledEntry) async throws {
    guard entry.format == DatasetArchive.format else { throw BundleMismatch(field: .format) }
    do {
      guard try FileSize.bytes(of: archive) == entry.bytes else {
        throw BundleMismatch(field: .bytes)
      }
      guard try DatasetArchive.digest(of: archive) == entry.sha256.rawValue else {
        throw BundleMismatch(field: .sha256)
      }
    } catch let mismatch as BundleMismatch {
      throw mismatch
    } catch {
      throw BundleMismatch(field: .bytes)
    }
    var line = 0
    do {
      try await BrotliLines(url: archive).eachLine { data, _ in
        defer { line += 1 }
        guard line == 0 else {
          try admit(header: data, entry: entry)
          throw HeaderRead()
        }
        guard data == DirectoryArchiveReader.signature else {
          throw BundleMismatch(field: .format)
        }
      }
    } catch is HeaderRead {
      return
    } catch let mismatch as BundleMismatch {
      throw mismatch
    } catch {
      throw BundleMismatch(field: .format)
    }
    throw BundleMismatch(field: .format)
  }

  private static func admit(header data: Data, entry: BundledEntry) throws {
    let header: ArchiveHeader
    do { header = try JSONDecoder().decode(ArchiveHeader.self, from: data).validated() } catch {
      throw BundleMismatch(field: .header)
    }
    guard header.snapshot == entry.snapshot else { throw BundleMismatch(field: .snapshot) }
    guard header.contacts == entry.contacts else { throw BundleMismatch(field: .contacts) }
    guard header.generatedAt == entry.generatedAt else {
      throw BundleMismatch(field: .generatedAt)
    }
  }
}

enum FileSize {
  /// Reads the size from the open file, because a URL caches its resource values and file attributes need a declared reason.
  static func bytes(of url: URL) throws -> Int {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    return Int(try handle.seekToEnd())
  }
}
