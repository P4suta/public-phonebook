import Foundation
import PhonebookCore

struct DirectoryDiscovery: Decodable, Sendable {
  let version: String
  let snapshot: SnapshotID
  let generatedAt: String
  let datasets: String

  func resource() throws -> Resource<Endpoints> {
    guard version == "1" else { throw ServiceError.invalidResponse }
    return Resource(
      data: Endpoints(datasets: datasets),
      meta: SnapshotMeta(snapshot: snapshot, generatedAt: generatedAt))
  }
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
