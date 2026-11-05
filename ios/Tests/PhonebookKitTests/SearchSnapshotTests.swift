import Foundation
import PhonebookCore
import Testing

@testable import PhonebookKit

func searchFixture(in root: URL, header: ArchiveHeader, lines: [ArchiveLine]) throws
  -> SearchArtifactFiles
{
  let names = lines.map(\.name).sorted()
  let namePart = Data(names.map { SearchInput.normalizedName($0) + "\t" + $0 + "\n" }.joined().utf8)
  let phones = Data(names.map { _ in "0353211111\n" }.joined().utf8)
  let indexHeader: [String: Any] = [
    "snapshot": header.snapshot.rawValue, "contacts": names.count,
    "categories": [["id": "library", "label": "Library"]],
    "prefectures": header.prefectures.map { ["code": $0.code.rawValue, "name": $0.name] },
    "municipalities": [["code": "13101", "name": "千代田区"]], "regions": ["13101"],
    "parts": [
      "names": namePart.count, "categories": names.count, "regions": names.count * 2,
      "phones": phones.count,
    ],
  ]
  var index = Data("public-phonebook-search-index\t1\n".utf8)
  index += try JSONSerialization.data(withJSONObject: indexHeader)
  index += Data([10]) + namePart + Data(repeating: 0, count: names.count * 3) + phones
  let metadata: [String: Any] = [
    "snapshot": header.snapshot.rawValue, "contacts": names.count,
    "analyzer": ["engine": "fixture", "dictionary": String(repeating: "a", count: 64)],
    "readings": names, "lexicon": [], "aliases": [], "variants": [], "unknownWeight": 1,
    "lexical": [], "phonetic": [],
  ]
  var ranking = Data("public-phonebook-search-ranking\t1\n".utf8)
  ranking += try JSONSerialization.data(withJSONObject: metadata)
  ranking += Data([10])
  let compressedIndex = try brotli(index)
  let compressedRanking = try brotli(ranking)
  let directory = root.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  try compressedIndex.write(to: directory.appendingPathComponent("search-index.br"))
  try compressedRanking.write(to: directory.appendingPathComponent("search-ranking.br"))
  let manifest = try SearchArtifactManifest(
    snapshot: header.snapshot, contacts: names.count,
    index: SearchArtifactIdentity(
      bytes: compressedIndex.count, sha256: SnapshotID(sha256Hex(compressedIndex)),
      uncompressedBytes: index.count, uncompressedSha256: SnapshotID(sha256Hex(index))),
    ranking: SearchArtifactIdentity(
      bytes: compressedRanking.count, sha256: SnapshotID(sha256Hex(compressedRanking)),
      uncompressedBytes: ranking.count, uncompressedSha256: SnapshotID(sha256Hex(ranking))))
  try JSONEncoder().encode(manifest).write(to: directory.appendingPathComponent("search.json"))
  return try SearchArtifactFiles.open(directory: directory)
}

@Test func searchArtifactsMustMapEverySavedRecordBeforeActivation() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let lines = [ArchiveLine(name: "Library Annex"), ArchiveLine(name: "Library")]
  let header = try sampleHeader(counts: ["13": lines.count])
  let artifacts = try searchFixture(in: root, header: header, lines: lines)
  let store = try SnapshotStore(root: root.appendingPathComponent("store"))
  try await store.begin(header: header, requiresRankedSearch: true)
  try await store.append(records(lines, header: header))
  await #expect(throws: (any Error).self) { try await store.publish(at: Date()) }
  try await store.installSearch(artifacts)
  let saved = try await store.publish(at: Date())
  #expect(saved.rankedSearch == true)
  let search = try #require(try await store.rankedSearch(generation: saved.generation))
  #expect(try search.search("Library").map(\.id) == [2])
  #expect(try search.search("Library Annex").map(\.id) == [1])
  #expect(try await CallerFile.active(in: store.root)?.generation == saved.generation)
}

@Test func rejectedSearchMappingsAndCorruptFilesKeepTheActiveGeneration() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let store = try SnapshotStore(root: root.appendingPathComponent("store"))
  let original = try await publish([ArchiveLine(name: "Saved")], to: store)
  let header = try sampleHeader(snapshot: "b")
  let artifacts = try searchFixture(
    in: root, header: header, lines: [ArchiveLine(name: "Different")])
  try await store.begin(header: header, requiresRankedSearch: true)
  try await store.append(records([ArchiveLine(name: "Actual")], header: header))
  await #expect(throws: (any Error).self) { try await store.installSearch(artifacts) }
  try await store.abort()
  #expect(try await store.manifest()?.generation == original.generation)
  #expect(
    try await store.contacts(generation: original.generation, ids: [1]).first?.name == "Saved")
  try Data([0]).write(to: artifacts.index)
  #expect(throws: (any Error).self) { try artifacts.admit() }
}

private struct FixedSearchArtifacts: SearchArtifactSource {
  let value: SearchArtifactFiles

  func transferBytes(snapshot: SnapshotID, contacts: Int, paths: NetworkPaths) async throws -> Int {
    0
  }
  func files(snapshot: SnapshotID, contacts: Int, paths: NetworkPaths, partials: URL) async throws
    -> SearchArtifactFiles
  { value }
  func release(snapshot: SnapshotID, partials: URL) async throws {}
}

@Test func upgradingSearchRetainsTheSavedDirectoryAndNeedsNoArchiveDownload() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let store = try SnapshotStore(root: root.appendingPathComponent("store"))
  let lines = [ArchiveLine(name: "Library")]
  let old = try await publish(lines, to: store)
  let files = try searchFixture(in: root, header: sampleHeader(), lines: lines)
  let api = try APIClient(origin: #require(URL(string: "https://example.com")))
  let sync = SyncEngine(api: api, store: store, searchArtifacts: FixedSearchArtifacts(value: files))
  let saved = try await sync.upgradeSearch()
  #expect(saved.previous == old.generation)
  #expect(saved.rankedSearch == true)
  #expect(try await store.contacts(generation: old.generation, ids: [1]).first?.name == "Library")
  #expect(try await sync.upgradeSearch().generation == saved.generation)
  let map = await store.root.appendingPathComponent(saved.generation.uuidString + ".search-rows")
  try Data([0, 0, 0, 0]).write(to: map)
  await #expect(throws: (any Error).self) {
    try await store.rankedSearch(generation: saved.generation)
  }
}

@Test func rankedGenerationsKeepDuplicatesAndCleanOnlyTheObsoleteFiles() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let directory = root.appendingPathComponent("store")
  let store = try SnapshotStore(root: directory)
  let lines = [
    ArchiveLine(name: "Library"), ArchiveLine(name: "Library", address: "Another address"),
  ]
  var saved: [SnapshotManifest] = []
  for snapshot: Character in ["a", "b", "c"] {
    let header = try sampleHeader(snapshot: snapshot, counts: ["13": lines.count])
    let files = try searchFixture(in: root, header: header, lines: lines)
    try await store.begin(header: header, requiresRankedSearch: true)
    try await store.append(records(lines, header: header))
    try await store.installSearch(files)
    saved.append(try await store.publish(at: Date()))
  }
  let previous = try #require(try await store.rankedSearch(generation: saved[1].generation))
  #expect(try previous.search("Library").map(\.id) == [1, 2])
  let names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
  #expect(!names.contains { $0.hasPrefix(saved[0].generation.uuidString) })
  #expect(names.contains(saved[1].generation.uuidString + ".search-ranking.br"))
  #expect(names.contains(saved[2].generation.uuidString + ".search-rows"))
  let map = directory.appendingPathComponent(saved[2].generation.uuidString + ".search-rows")
  try Data([2, 0, 0, 0, 1, 0, 0, 0]).write(to: map)
  await #expect(throws: (any Error).self) {
    try await store.rankedSearch(generation: saved[2].generation)
  }
}

func providerSearchFiles(_ revision: String, in root: URL) throws -> SearchArtifactFiles {
  let entries = try corpus(revision)
  let listing = try #require(entries.first { $0.path == "/api/datasets" })
  let datasets = try JSONDecoder().decode(DirectoryDatasets.self, from: listing.data)
  let index = try #require(entries.first { $0.path == "/api/search-index" })
  let ranking = try #require(entries.first { $0.path == "/api/search-ranking" })
  let decoder = JSONDecoder()
  let manifest = try SearchArtifactManifest(
    snapshot: datasets.snapshot, contacts: datasets.contacts,
    index: decoder.decode(SearchArtifactIdentity.self, from: index.data),
    ranking: decoder.decode(SearchArtifactIdentity.self, from: ranking.data))
  let directory = root.appendingPathComponent("search-" + revision)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  for (kind, identity) in [("search-index", manifest.index), ("search-ranking", manifest.ranking)] {
    let response = try #require(
      entries.first {
        $0.path == "/api/\(kind)/\(datasets.snapshot.rawValue)/\(identity.sha256.rawValue)/download"
      })
    try response.data.write(to: directory.appendingPathComponent(kind + ".br"))
  }
  try JSONEncoder().encode(manifest).write(to: directory.appendingPathComponent("search.json"))
  return try SearchArtifactFiles.open(directory: directory)
}

private struct OfflineSearchTransport: HTTPTransport {
  func send(_ request: URLRequest) async throws -> HTTPResult {
    throw URLError(.notConnectedToInternet)
  }
}

@Test func bundledSearchWorksWithoutAnyPublishedSearchFilesOrConnection() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let bundle = try bundledFixture(in: root)
  let archive = try await BundledDataset.open(
    archive: bundle.archive, entry: writeEntry(bundle.entry, in: root))
  let files = try providerSearchFiles("baseline", in: root)
  let api = try APIClient(
    origin: #require(URL(string: "https://example.com")), transport: OfflineSearchTransport())
  let source = SearchArtifactRepository(
    api: api, bundledDirectory: files.index.deletingLastPathComponent())
  let store = try SnapshotStore(root: root.appendingPathComponent("store"))
  let result = try await SyncEngine(api: api, store: store, searchArtifacts: source).firstRun(
    bundle: archive, progress: { _ in })
  #expect(result.outcome == .bundled)
  #expect(result.manifest.rankedSearch == true)
  let search = try #require(try await store.rankedSearch(generation: result.manifest.generation))
  let hits = try search.search("こうかいとしょかん")
  let first = try #require(hits.first)
  #expect(
    try await store.contacts(generation: result.manifest.generation, ids: [first.id]).first?.name
      == "公開図書館")
}

@Test func completeAndDeltaUpdatesActivateTheMatchingSearchPair() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let store = try SnapshotStore(root: root.appendingPathComponent("store"))
  let first = try await corpusServer(corpus("baseline"))
  let baselineAPI = try APIClient(origin: first.origin)
  let baseline = try await SyncEngine(
    api: baselineAPI, store: store, searchArtifacts: SearchArtifactRepository(api: baselineAPI)
  ).synchronize(progress: { _ in })
  let requests = RequestLog()
  let next = try await corpusServer(corpus("updated"), requests: requests)
  let api = try APIClient(origin: next.origin)
  let saved = try await SyncEngine(
    api: api, store: store, searchArtifacts: SearchArtifactRepository(api: api)
  ).synchronize(progress: { _ in })
  #expect(saved.previous == baseline.generation)
  #expect(saved.rankedSearch == true)
  #expect(requests.ordered.contains { $0.contains("/directory-delta-") })
  #expect(!requests.ordered.contains { $0.hasSuffix("/directory.tsv.br") })
  #expect(requests.ordered.filter { $0.hasSuffix("/download") }.count == 2)
  let search = try #require(try await store.rankedSearch(generation: saved.generation))
  #expect(try !search.search("こうかいとしょかん").isEmpty)
  for kind in ["search-index", "search-ranking"] {
    let directory = store.searchTransfers.appendingPathComponent(kind)
    #expect(
      try FileManager.default.contentsOfDirectory(atPath: directory.path).filter {
        $0.hasSuffix(".partial")
      }.isEmpty)
  }
}
