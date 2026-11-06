import Foundation
import PhonebookCore
import PhonebookRanking
import Testing

@testable import PhonebookKit

private func rankedDirectory(
  root: URL, lines: [ArchiveLine], aliases: [(row: Int, kana: String)] = []
) async throws -> (SnapshotStore, SnapshotManifest) {
  let header = try sampleHeader(counts: ["13": lines.count])
  let artifacts = try searchFixture(in: root, header: header, lines: lines, aliases: aliases)
  let store = try SnapshotStore(root: root.appendingPathComponent("store"))
  try await store.begin(header: header, requiresRankedSearch: true)
  try await store.append(records(lines, header: header))
  try await store.installSearch(artifacts)
  return (store, try await store.publish(at: Date()))
}

/// The names that the screen shows, category by category.
@MainActor private func shownNames(_ model: DirectoryModel) -> [[String]] {
  model.results?.groups.map { model.visible($0).map(\.name) } ?? []
}

@MainActor @Test func directoryModelDefaultsToLiteralSearchEvenWithSavedRanking() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, saved) = try await rankedDirectory(
    root: root,
    lines: [ArchiveLine(name: "Alpha"), ArchiveLine(category: 1, name: "Beta")],
    aliases: [(0, "demo"), (1, "demo")])
  let model = DirectoryModel(store: store)
  await model.activate(saved)
  model.query = "demo"
  await model.search()?.value
  #expect(model.results?.ids == [])
  model.query = "a"
  await model.search()?.value
  #expect(shownNames(model) == [["Alpha"], ["Beta"]])
  #expect(model.results?.limited == false)
}

@Test func removingSearchArtifactsPreservesTheSavedDirectoryAndIsRepeatable() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, saved) = try await rankedDirectory(root: root, lines: [ArchiveLine(name: "Alpha")])
  let storage = await store.root
  try FileManager.default.removeItem(
    at: storage.appendingPathComponent(saved.generation.uuidString + ".search-ranking"))
  let previous = UUID()
  for name in ["search-index.br", "search-ranking.br", "search.json", "search-rows"] {
    try Data().write(to: storage.appendingPathComponent(previous.uuidString + "." + name))
  }
  try FileManager.default.createDirectory(
    at: store.searchTransfers, withIntermediateDirectories: true)
  try await store.removeSearchArtifacts()
  try await store.removeSearchArtifacts()
  let literal = try #require(try await store.manifest())
  #expect(literal.generation == saved.generation)
  #expect(literal.snapshot == saved.snapshot)
  #expect(literal.rankedSearch == nil)
  #expect(try await store.contacts(generation: saved.generation, ids: [1]).map(\.name) == ["Alpha"])
  #expect(try await store.rankedSearch(generation: saved.generation) == nil)
  #expect(!FileManager.default.fileExists(atPath: store.searchTransfers.path))
  #expect(
    try FileManager.default.contentsOfDirectory(atPath: storage.path).allSatisfy {
      !$0.contains(".search")
    })
}

@MainActor @Test func directoryModelGroupsRankedResultsByCategory() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, saved) = try await rankedDirectory(
    root: root,
    lines: [
      ArchiveLine(name: "Alpha"), ArchiveLine(name: "Gamma"),
      ArchiveLine(category: 1, name: "Beta"),
    ],
    aliases: [(0, "demo"), (1, "demo"), (2, "demo")])
  let model = DirectoryModel(store: store, allowsForgivingSearch: true)
  await model.activate(saved)
  model.query = "demo"
  await model.search()?.value
  // The scorer ranks Alpha, Beta, and Gamma, so Alpha's category comes first and keeps Gamma after Alpha.
  #expect(model.results?.ids == [1, 2, 3])
  #expect(shownNames(model) == [["Alpha", "Gamma"], ["Beta"]])
}

@MainActor @Test func directoryModelPreservesWrittenExactQueriesBeforeFolding() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, saved) = try await rankedDirectory(
    root: root, lines: [ArchiveLine(name: "高田医院"), ArchiveLine(name: "髙田医院")])
  let model = DirectoryModel(store: store, allowsForgivingSearch: true)
  await model.activate(saved)
  for (query, id): (String, Int64) in [("髙田医院", 2), ("高田医院", 1)] {
    model.query = query
    await model.search()?.value
    #expect(model.results?.ids == [id])
  }
}

private actor SearchGate {
  private var entered = false
  private var released = false
  private var waiting: CheckedContinuation<Void, Never>?
  private var observer: CheckedContinuation<Void, Never>?

  func pause() async {
    entered = true
    observer?.resume()
    observer = nil
    if released { return }
    await withCheckedContinuation { waiting = $0 }
  }

  func waitForEntry() async {
    if entered { return }
    await withCheckedContinuation { observer = $0 }
  }

  func release() {
    released = true
    waiting?.resume()
    waiting = nil
  }
}

private actor DelayedDirectory: DirectorySearchSource {
  let base: SnapshotStore
  private var contactsGate: SearchGate?
  private var headerGate: SearchGate?
  private var omit = false

  init(_ base: SnapshotStore) { self.base = base }
  func holdContacts(_ gate: SearchGate) { contactsGate = gate }
  func holdHeader(_ gate: SearchGate) { headerGate = gate }
  func omitOneContact() { omit = true }

  func header(generation: UUID) async throws -> ArchiveHeader {
    if let gate = headerGate {
      headerGate = nil
      await gate.pause()
    }
    return try await base.header(generation: generation)
  }
  func searchIndex(generation: UUID) async throws -> LocalSearch {
    try await base.searchIndex(generation: generation)
  }
  func rankedSearch(generation: UUID) async throws -> SavedRankedSearch? {
    try await base.rankedSearch(generation: generation)
  }
  func contactIDs(generation: UUID, number: Int64) async throws -> [Int64] {
    try await base.contactIDs(generation: generation, number: number)
  }
  func contacts(generation: UUID, ids: [Int64]) async throws -> [Contact] {
    if let gate = contactsGate {
      contactsGate = nil
      await gate.pause()
    }
    let result = try await base.contacts(generation: generation, ids: ids)
    if omit {
      omit = false
      return Array(result.dropFirst())
    }
    return result
  }
}

private func delayedDirectory(root: URL) async throws -> (DelayedDirectory, SnapshotManifest) {
  let store = try SnapshotStore(root: root)
  let lines = ["A", "B"].flatMap { prefix in
    (0..<60).map { ArchiveLine(name: prefix + String(format: "%02d", $0)) }
  }
  return (DelayedDirectory(store), try await publish(lines, to: store))
}

@MainActor @Test func anOlderSearchCannotReplaceTheCurrentQuery() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let (source, saved) = try await delayedDirectory(root: root)
  let model = DirectoryModel(store: source)
  await model.activate(saved)
  let gate = SearchGate()
  defer { Task { await gate.release() } }
  await source.holdContacts(gate)
  model.query = "A"
  let old = model.search()
  await gate.waitForEntry()
  model.query = "B"
  await model.search()?.value
  await gate.release()
  await old?.value
  #expect(model.results?.input == "B")
  #expect(shownNames(model).flatMap { $0 }.count == DirectoryModel.previewSize)
  #expect(shownNames(model).flatMap { $0 }.allSatisfy { $0.hasPrefix("B") })
  #expect(!model.searching)
}

@MainActor @Test func anOlderPageCannotClearTheCurrentPageOperation() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let (source, saved) = try await delayedDirectory(root: root)
  let model = DirectoryModel(store: source)
  await model.activate(saved)
  model.query = "A"
  await model.search()?.value
  let oldGate = SearchGate()
  let currentGate = SearchGate()
  defer {
    Task {
      await oldGate.release()
      await currentGate.release()
    }
  }
  await source.holdContacts(oldGate)
  let old = model.more(try #require(model.results?.groups.first))
  await oldGate.waitForEntry()
  model.query = "B"
  await model.search()?.value
  let group = try #require(model.results?.groups.first)
  await source.holdContacts(currentGate)
  let current = model.more(group)
  await currentGate.waitForEntry()
  await oldGate.release()
  await old?.value
  #expect(model.loadingMore)
  #expect(model.visible(group).count == DirectoryModel.previewSize)
  await currentGate.release()
  await current?.value
  #expect(!model.loadingMore)
  #expect(model.visible(group).count == DirectoryModel.previewSize + DirectoryModel.pageSize)
  #expect(model.visible(group).allSatisfy { $0.name.hasPrefix("B") })
}

@MainActor @Test func searchPreparationUsesTheLatestTypedInputAndRejectsMissingContacts()
  async throws
{
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let (source, saved) = try await delayedDirectory(root: root)
  let model = DirectoryModel(store: source)
  let gate = SearchGate()
  defer { Task { await gate.release() } }
  await source.holdHeader(gate)
  let activation = Task { await model.activate(saved) }
  await gate.waitForEntry()
  #expect(model.loading)
  model.query = "B"
  #expect(model.search() == nil)
  await gate.release()
  await activation.value
  await model.search()?.value
  #expect(!model.loading)
  #expect(model.results?.input == "B")
  await source.omitOneContact()
  model.query = "A"
  await model.search()?.value
  #expect(model.failed)
  #expect(model.results == nil)
  model.retry()
  await model.search()?.value
  #expect(!model.failed)
  #expect(model.results?.input == "A")
}

@MainActor @Test func telephoneResultsGroupEveryCategoryInNameOrder() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, saved) = try await rankedDirectory(
    root: root,
    lines: [
      ArchiveLine(name: "Alpha"), ArchiveLine(name: "Gamma"),
      ArchiveLine(category: 1, name: "Beta"),
    ])
  let model = DirectoryModel(store: store)
  await model.activate(saved)
  model.query = "03-5321-1111"
  await model.search()?.value
  #expect(shownNames(model) == [["Alpha", "Gamma"], ["Beta"]])
  #expect(model.results?.limited == false)
}

private struct OfflineDirectory: HTTPTransport {
  func send(_ request: URLRequest) async throws -> HTTPResult {
    throw URLError(.notConnectedToInternet)
  }
}

@MainActor @Test func rankedResultPagingPreservesTheFrozenOrder() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let bundle = try bundledFixture(in: root)
  let archive = try await BundledDataset.open(
    archive: bundle.archive, entry: writeEntry(bundle.entry, in: root))
  let files = try providerSearchFiles("baseline", in: root)
  let api = try APIClient(
    origin: #require(URL(string: "https://example.com")), transport: OfflineDirectory())
  let source = SearchArtifactRepository(
    api: api, bundledDirectory: files.index.deletingLastPathComponent())
  let store = try SnapshotStore(root: root.appendingPathComponent("store"))
  let saved = try await SyncEngine(api: api, store: store, searchArtifacts: source).firstRun(
    bundle: archive, progress: { _ in })
  let scorer = try #require(try await store.rankedSearch(generation: saved.manifest.generation))
  let ranked = try scorer.search("facility").map(\.id)
  #expect(ranked.count == 100)
  let records = try await store.contacts(generation: saved.manifest.generation, ids: ranked)
  let keys = Dictionary(uniqueKeysWithValues: records.map { ($0.id, $0.categoryKey) })
  var order: [String] = []
  var expected: [String: [Int64]] = [:]
  for id in ranked {
    let key = try #require(keys[id])
    if expected[key] == nil { order.append(key) }
    expected[key, default: []].append(id)
  }
  let model = DirectoryModel(store: store, allowsForgivingSearch: true)
  await model.activate(saved.manifest)
  model.query = "facility"
  await model.search()?.value
  #expect(model.results?.limited == true)
  let groups = try #require(model.results?.groups)
  #expect(groups.map(\.key) == order)
  for group in groups {
    let ids = try #require(expected[group.key])
    #expect(model.visible(group).map(\.id) == Array(ids.prefix(DirectoryModel.previewSize)))
    while model.expandable(group) { await model.more(group)?.value }
    #expect(model.visible(group).map(\.id) == ids)
  }
}
