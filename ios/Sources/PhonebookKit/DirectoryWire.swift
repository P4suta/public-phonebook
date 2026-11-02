import Foundation
import PhonebookCore

struct DirectoryDiscovery: Decodable, Sendable {
  let version: String
  let snapshot: SnapshotID
  let generatedAt: String
  let datasets: String
  let datasetDeltas: String?

  func resource() throws -> Resource<Endpoints> {
    guard version == "1" else { throw ServiceError.invalidResponse }
    return Resource(
      data: Endpoints(datasets: datasets, datasetDeltas: datasetDeltas),
      meta: SnapshotMeta(snapshot: snapshot, generatedAt: generatedAt))
  }
}

struct DirectoryDeltaListing: Decodable, Sendable {
  struct Delta: Decodable, Sendable {
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
  let deltas: [Delta]
}

struct DirectoryDatasets: Decodable, Sendable {
  struct File: Decodable, Sendable {
    let file: String
    let sha256: SnapshotID
    let bytes: Int
    let url: String
  }
  let snapshot: SnapshotID
  let generatedAt: String
  let contacts: Int
  let files: [File]
}
