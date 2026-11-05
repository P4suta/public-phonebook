import Foundation
import PhonebookCore

public protocol SearchArtifactSource: Sendable {
  func transferBytes(snapshot: SnapshotID, contacts: Int, paths: NetworkPaths) async throws -> Int
  func files(snapshot: SnapshotID, contacts: Int, paths: NetworkPaths, partials: URL) async throws
    -> SearchArtifactFiles
  func release(snapshot: SnapshotID, partials: URL) async throws
}

public actor SearchArtifactRepository: SearchArtifactSource {
  private struct Location: Decodable {
    let snapshot: SnapshotID
    let format: String?
    let url: String
    let sha256: SnapshotID
    let bytes: Int
    let uncompressedBytes: Int
    let uncompressedSha256: SnapshotID

    func identity() throws -> SearchArtifactIdentity {
      try SearchArtifactIdentity(
        bytes: bytes, sha256: sha256, uncompressedBytes: uncompressedBytes,
        uncompressedSha256: uncompressedSha256)
    }
  }

  private struct Download: DatasetFile {
    let snapshot: SnapshotID
    let link: String
    let sha256: SnapshotID
    let bytes: Int
  }

  private let api: APIClient
  private let bundledDirectory: URL?
  private var discovered: SearchArtifactManifest?

  public init(api: APIClient, bundledDirectory: URL? = nil) {
    self.api = api
    self.bundledDirectory = bundledDirectory
  }

  private func bundled(snapshot: SnapshotID, contacts: Int) -> SearchArtifactFiles? {
    guard let bundledDirectory,
      let files = try? SearchArtifactFiles.open(directory: bundledDirectory),
      files.manifest.snapshot == snapshot, files.manifest.contacts == contacts
    else { return nil }
    return files
  }

  private func discover(snapshot: SnapshotID, contacts: Int, paths: NetworkPaths) async throws
    -> SearchArtifactManifest
  {
    if let discovered, discovered.snapshot == snapshot, discovered.contacts == contacts {
      return discovered
    }
    func location(_ kind: String) async throws -> Location {
      let result = try await api.get("/api/\(kind)", paths: paths)
      let location = try JSONDecoder().decode(Location.self, from: result.data)
      try api.validateIdentity(snapshot, response: result.response)
      guard location.snapshot == snapshot,
        location.url == "/api/\(kind)/\(snapshot.rawValue)/\(location.sha256.rawValue)",
        kind != "search-ranking" || location.format == "public-phonebook-search-ranking/1"
      else { throw RankingError.identityMismatch }
      return location
    }
    let index = try await location("search-index")
    let ranking = try await location("search-ranking")
    let manifest = try SearchArtifactManifest(
      snapshot: snapshot, contacts: contacts, index: index.identity(), ranking: ranking.identity())
    discovered = manifest
    return manifest
  }

  public func transferBytes(snapshot: SnapshotID, contacts: Int, paths: NetworkPaths) async throws
    -> Int
  {
    if bundled(snapshot: snapshot, contacts: contacts) != nil { return 0 }
    let manifest = try await discover(snapshot: snapshot, contacts: contacts, paths: paths)
    return manifest.index.bytes + manifest.ranking.bytes
  }

  public func files(snapshot: SnapshotID, contacts: Int, paths: NetworkPaths, partials: URL)
    async throws -> SearchArtifactFiles
  {
    if let files = bundled(snapshot: snapshot, contacts: contacts) { return files }
    let manifest = try await discover(snapshot: snapshot, contacts: contacts, paths: paths)
    func download(_ identity: SearchArtifactIdentity, kind: String) async throws -> URL {
      try await api.download(
        Download(
          snapshot: snapshot,
          link: "/api/\(kind)/\(snapshot.rawValue)/\(identity.sha256.rawValue)/download",
          sha256: identity.sha256, bytes: identity.bytes),
        paths: paths, partials: partials.appendingPathComponent(kind))
    }
    let index = try await download(manifest.index, kind: "search-index")
    let ranking = try await download(manifest.ranking, kind: "search-ranking")
    return try SearchArtifactFiles(manifest: manifest, index: index, ranking: ranking)
  }

  public func release(snapshot: SnapshotID, partials: URL) async throws {
    guard let discovered, discovered.snapshot == snapshot else { return }
    for (kind, identity) in [
      ("search-index", discovered.index), ("search-ranking", discovered.ranking),
    ] {
      let file = partials.appendingPathComponent(kind).appendingPathComponent(
        "\(snapshot.rawValue)-\(identity.sha256.rawValue).partial")
      if FileManager.default.fileExists(atPath: file.path) {
        try FileManager.default.removeItem(at: file)
      }
    }
  }
}
