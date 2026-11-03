import Foundation
import PhonebookCore

/// A listing entry type that the app decodes only when the entry declares the app's format.
protocol ListedFormat: Decodable, Sendable {
  static var format: String { get }
}

/// One listed entry, which stays unread when it declares a format that this app doesn't know.
struct Listed<Entry: ListedFormat>: Decodable, Sendable {
  let entry: Entry?

  private enum Key: String, CodingKey { case format }

  init(from decoder: any Decoder) throws {
    let format = try decoder.container(keyedBy: Key.self).decode(String.self, forKey: .format)
    entry = format == Entry.format ? try Entry(from: decoder) : nil
  }
}

struct DirectoryDeltaListing: Decodable, Sendable {
  struct Delta: ListedFormat {
    static var format: String { DatasetDelta.format }
    let base: SnapshotID
    let baseArchiveSha256: SnapshotID
    let file: String
    let sha256: SnapshotID
    let bytes: Int
    let uncompressedSha256: SnapshotID
    let uncompressedBytes: Int
    let url: String
  }
  let snapshot: SnapshotID
  let archiveSha256: SnapshotID
  let deltas: [Listed<Delta>]
}

struct DirectoryDatasets: Decodable, Sendable {
  struct File: ListedFormat {
    static var format: String { DatasetArchive.format }
    let file: String
    let sha256: SnapshotID
    let bytes: Int
    let url: String
  }
  let snapshot: SnapshotID
  let generatedAt: String
  let contacts: Int
  let files: [Listed<File>]
  /// The pinned delta listing, which a provider that doesn't publish deltas omits.
  let datasetDeltas: String?
}
