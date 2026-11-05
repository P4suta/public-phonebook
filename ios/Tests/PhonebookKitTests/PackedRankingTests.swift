import Foundation
import Testing

@testable import PhonebookCore
@testable import PhonebookKit

private struct PackedTestSource: SearchArtifactSource {
  let value: SearchArtifactFiles
  func transferBytes(snapshot: SnapshotID, contacts: Int, paths: NetworkPaths) async throws -> Int {
    0
  }
  func files(snapshot: SnapshotID, contacts: Int, paths: NetworkPaths, partials: URL) async throws
    -> SearchArtifactFiles
  { value }
  func release(snapshot: SnapshotID, partials: URL) async throws {}
}

private struct PackedContract: Decodable, Sendable {
  struct Query: Decodable, Sendable {
    let query: String
    let hits: [[Int64]]
  }
  let snapshot: String
  let contacts: Int
  let rankingSha256: String
  let queries: [Query]
}

private func expectBoundedCache(_ packed: PackedRanking) {
  for dictionary in [packed.lexical, packed.phonetic] {
    let usage = dictionary.cacheUsage
    #expect((0...(4 * 1_048_576)).contains(usage.bytes))
    #expect((1...256).contains(usage.entries))
  }
}

@Test func packedNationalRankingsMatchTheUnchangedContract() async throws {
  let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()
  let fixture = try JSONDecoder().decode(
    PackedContract.self,
    from: Data(contentsOf: root.appending(path: "tests/fixtures/search-ranking.json")))
  let manifest = try JSONDecoder().decode(
    SearchArtifactManifest.self,
    from: Data(contentsOf: root.appending(path: "ios/SearchData/national-packed.json")))
  let files = try SearchArtifactFiles(
    manifest: manifest, index: root.appending(path: "ios/SearchData/search-index.br"),
    ranking: root.appending(path: "ios/SearchData/search-ranking-packed.br"))
  let admitted = try files.admit()
  let packed = try #require(admitted.ranking.packed)
  #expect(packed.sourceSha256 == fixture.rankingSha256)
  #expect(admitted.index.rows.count == fixture.contacts)
  let scorer = try admitted.index.scorer(admitted.ranking)
  for query in fixture.queries {
    let hits = try scorer.search(query.query).map { [Int64($0.row), $0.score] }
    #expect(hits == query.hits, "Packed ranking differs for \(query.query)")
    if hits != query.hits { return }
  }
  expectBoundedCache(packed)
  let coldArtifact = try SearchArtifacts.ranking(
    admitted.rankingBytes, snapshot: fixture.snapshot, contacts: fixture.contacts,
    completeValidation: false)
  let cold = try admitted.index.scorer(coldArtifact)
  await withTaskGroup(of: Bool.self) { group in
    for query in fixture.queries.prefix(64) {
      group.addTask {
        (try? cold.search(query.query).map { [Int64($0.row), $0.score] }) == query.hits
      }
    }
    for await matched in group { #expect(matched) }
  }
  expectBoundedCache(try #require(coldArtifact.packed))
  #expect(throws: (any Error).self) {
    try PackedRanking(
      data: admitted.rankingBytes, snapshot: String(repeating: "b", count: 64),
      contacts: fixture.contacts)
  }
  #expect(throws: (any Error).self) {
    try PackedRanking(
      data: admitted.rankingBytes.dropLast(1), snapshot: fixture.snapshot,
      contacts: fixture.contacts)
  }
}

@Test func savedSearchVerifiesDecodedFilesAndLineOffsets() async throws {
  for component in ["search-index", "search-ranking", "search-lines"] {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let lines = [ArchiveLine(name: "Library")]
    let header = try sampleHeader()
    let artifacts = try searchFixture(in: root, header: header, lines: lines)
    let store = try SnapshotStore(root: root.appendingPathComponent("store"))
    try await store.begin(header: header, requiresRankedSearch: true)
    try await store.append(records(lines, header: header))
    try await store.installSearch(artifacts)
    let saved = try await store.publish(at: Date())
    #expect(await store.searchUsesMappedFiles(generation: saved.generation))
    let target = root.appendingPathComponent("store").appendingPathComponent(
      saved.generation.uuidString + "." + component)
    let handle = try FileHandle(forUpdating: target)
    try handle.write(contentsOf: Data([255]))
    try handle.close()
    await #expect(throws: (any Error).self) {
      try await store.rankedSearch(generation: saved.generation)
    }
  }
}

@Test func compressedSavedSearchRemainsReadableAndUpgradesAtomically() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let lines = [ArchiveLine(name: "Library")]
  let header = try sampleHeader()
  let artifacts = try searchFixture(in: root, header: header, lines: lines)
  let store = try SnapshotStore(root: root.appendingPathComponent("store"))
  try await store.begin(header: header, requiresRankedSearch: true)
  try await store.append(records(lines, header: header))
  try await store.installSearch(artifacts)
  let old = try await store.publish(at: Date())
  struct Legacy: Encodable {
    let format = "public-phonebook-saved-search/1"
    let artifacts: SearchArtifactManifest
    let rowsSha256: SnapshotID
  }
  let prefix = root.appendingPathComponent("store").appendingPathComponent(
    old.generation.uuidString)
  let mapping = try Data(contentsOf: prefix.appendingPathExtension("search-rows"))
  try JSONEncoder().encode(
    Legacy(artifacts: artifacts.manifest, rowsSha256: SnapshotID(sha256Hex(mapping)))
  ).write(to: prefix.appendingPathExtension("search.json"))
  try FileManager.default.copyItem(
    at: artifacts.index, to: prefix.appendingPathExtension("search-index.br"))
  try FileManager.default.copyItem(
    at: artifacts.ranking, to: prefix.appendingPathExtension("search-ranking.br"))
  for component in ["search-index", "search-ranking", "search-lines"] {
    try FileManager.default.removeItem(at: prefix.appendingPathExtension(component))
  }
  let legacy = try #require(try await store.rankedSearch(generation: old.generation))
  #expect(try legacy.search("Library").map(\.id) == [1])
  #expect(!(await store.searchUsesMappedFiles(generation: old.generation)))
  let api = try APIClient(origin: #require(URL(string: "https://example.com")))
  let upgraded = try await SyncEngine(
    api: api, store: store, searchArtifacts: PackedTestSource(value: artifacts)
  ).upgradeSearch()
  #expect(upgraded.previous == old.generation)
  #expect(await store.searchUsesMappedFiles(generation: upgraded.generation))
  #expect(try await store.contacts(generation: old.generation, ids: [1]).first?.name == "Library")
}
