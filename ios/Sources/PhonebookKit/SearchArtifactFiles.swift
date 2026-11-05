import CryptoKit
import Foundation
import PhonebookCore

public struct SearchArtifactIdentity: Codable, Sendable {
  public let bytes: Int
  public let sha256: SnapshotID
  public let uncompressedBytes: Int
  public let uncompressedSha256: SnapshotID

  public init(
    bytes: Int, sha256: SnapshotID, uncompressedBytes: Int, uncompressedSha256: SnapshotID
  ) throws {
    self.bytes = bytes
    self.sha256 = sha256
    self.uncompressedBytes = uncompressedBytes
    self.uncompressedSha256 = uncompressedSha256
    try validate()
  }

  func validate() throws {
    guard (1...SearchArtifacts.maximumCompressedBytes).contains(bytes),
      (1...SearchArtifacts.maximumDecodedBytes).contains(uncompressedBytes)
    else { throw RankingError.invalidArtifact }
  }

  private func compressed(_ url: URL) throws -> Data {
    try validate()
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    let data = try handle.read(upToCount: bytes + 1) ?? Data()
    guard data.count == bytes, Self.digest(data) == sha256.rawValue else {
      throw RankingError.invalidArtifact
    }
    return data
  }

  func verify(_ url: URL) throws { _ = try compressed(url) }

  func decode(_ url: URL) throws -> Data {
    let data = try SearchArtifacts.decompress(compressed(url), limit: uncompressedBytes)
    guard data.count == uncompressedBytes, Self.digest(data) == uncompressedSha256.rawValue else {
      throw RankingError.invalidArtifact
    }
    return data
  }

  private static func digest(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
}

public struct SearchArtifactManifest: Codable, Sendable {
  public let format: String
  public let snapshot: SnapshotID
  public let contacts: Int
  public let index: SearchArtifactIdentity
  public let ranking: SearchArtifactIdentity

  public init(
    snapshot: SnapshotID, contacts: Int, index: SearchArtifactIdentity,
    ranking: SearchArtifactIdentity
  ) throws {
    format = "public-phonebook-bundled-search/1"
    self.snapshot = snapshot
    self.contacts = contacts
    self.index = index
    self.ranking = ranking
    try validate()
  }

  func validate() throws {
    guard format == "public-phonebook-bundled-search/1", (0...2_000_000).contains(contacts),
      index.bytes <= 8 * 1_048_576
    else { throw RankingError.invalidArtifact }
    try index.validate()
    try ranking.validate()
  }
}

public struct AdmittedSearchArtifacts: Sendable {
  public let index: SearchArtifactIndex
  public let ranking: RankingArtifact
}

public struct SearchArtifactFiles: Sendable {
  public let manifest: SearchArtifactManifest
  public let index: URL
  public let ranking: URL

  public init(manifest: SearchArtifactManifest, index: URL, ranking: URL) throws {
    try manifest.validate()
    self.manifest = manifest
    self.index = index
    self.ranking = ranking
    try manifest.index.verify(index)
    try manifest.ranking.verify(ranking)
  }

  public static func open(directory: URL) throws -> Self {
    let handle = try FileHandle(forReadingFrom: directory.appendingPathComponent("search.json"))
    defer { try? handle.close() }
    let data = try handle.read(upToCount: 65_537) ?? Data()
    guard data.count <= 65_536 else { throw RankingError.invalidArtifact }
    return try Self(
      manifest: JSONDecoder().decode(SearchArtifactManifest.self, from: data),
      index: directory.appendingPathComponent("search-index.br"),
      ranking: directory.appendingPathComponent("search-ranking.br"))
  }

  public func admit() throws -> AdmittedSearchArtifacts {
    try manifest.validate()
    let decoded = try SearchArtifacts.index(manifest.index.decode(index))
    guard decoded.snapshot == manifest.snapshot.rawValue, decoded.rows.count == manifest.contacts
    else {
      throw RankingError.identityMismatch
    }
    let ranking = try SearchArtifacts.ranking(
      manifest.ranking.decode(ranking), snapshot: manifest.snapshot.rawValue,
      contacts: manifest.contacts)
    return AdmittedSearchArtifacts(index: decoded, ranking: ranking)
  }
}

public struct SavedSearchHit: Sendable, Equatable {
  public let id: Int64
  public let score: Int64
}

public final class SavedRankedSearch: Sendable {
  private let scorer: RankedSearch
  private let ids: [UInt32]

  init(scorer: RankedSearch, ids: [UInt32]) {
    self.scorer = scorer
    self.ids = ids
  }

  public func search(_ query: String) throws -> [SavedSearchHit] {
    try scorer.search(query).map { SavedSearchHit(id: Int64(ids[$0.row]), score: $0.score) }
  }
}
