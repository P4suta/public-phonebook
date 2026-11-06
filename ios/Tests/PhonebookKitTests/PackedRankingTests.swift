import Foundation
import PhonebookCore
import Testing

@testable import PhonebookKit
@testable import PhonebookRanking

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
