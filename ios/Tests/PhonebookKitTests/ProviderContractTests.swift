import Foundation
import PhonebookCore
import Testing

@testable import PhonebookKit

struct CorpusEntry: Decodable {
  let revision: String
  let path: String
  let status: Int
  let headers: [String: String]
  let body: String
  let encoding: String?

  var data: Data {
    get throws {
      encoding == "base64" ? try #require(Data(base64Encoded: body)) : Data(body.utf8)
    }
  }
}

func corpus(_ revision: String) throws -> [CorpusEntry] {
  let url = try #require(Bundle.module.url(forResource: "DirectoryContract", withExtension: "json"))
  return try JSONDecoder().decode([CorpusEntry].self, from: Data(contentsOf: url))
    .filter { $0.revision == revision }
}

/// Serves the responses that the merged producer wrote for one revision of the provider corpus.
func corpusServer(_ entries: [CorpusEntry], requests: RequestLog = RequestLog())
  async throws -> HTTPTestServer
{
  let responses = try Dictionary(
    uniqueKeysWithValues: entries.map { entry in
      let headers = entry.headers.map { "\($0.key): \($0.value)\r\n" }.joined()
      let body = try entry.data
      return (
        entry.path,
        Data(
          "HTTP/1.1 \(entry.status) OK\r\nConnection: close\r\n\(headers)Content-Length: \(body.count)\r\n\r\n"
            .utf8) + body
      )
    })
  return try await HTTPTestServer { request in
    let target = request.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
    requests.record(target)
    return responses[target]
      ?? Data("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".utf8)
  }
}

@Test(.timeLimit(.minutes(1))) func currentProviderArchiveImportsTheNationalDirectory()
  async throws
{
  let entries = try corpus("baseline")
  let listing = try #require(entries.first { $0.path == "/api/datasets" })
  let datasets = try JSONDecoder().decode(DirectoryDatasets.self, from: listing.data)
  let server = try await corpusServer(entries)
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let store = try SnapshotStore(root: root)
  let manifest = try await SyncEngine(api: APIClient(origin: server.origin), store: store)
    .synchronize(progress: { _ in })
  #expect(manifest.snapshot == datasets.snapshot)
  #expect(manifest.records == datasets.contacts)
  let header = try await store.header(generation: manifest.generation)
  #expect(header.prefectures.count == 47)
  let search = try await store.searchIndex(generation: manifest.generation)
  let groups = try search.search(SearchInput.normalizedName("公開図書館"))
  let library = try #require(groups.first?.first)
  #expect(library.rank == .exact)
  let contact = try #require(
    try await store.contacts(generation: manifest.generation, ids: [library.id]).first)
  #expect(contact.name == "公開図書館")
  #expect(contact.prefecture.isEmpty == false)
  #expect(contact.provenance.publications.isEmpty == false)
  let shared = try await store.contactIDs(generation: manifest.generation, number: 81_300_000_000)
  #expect(shared.count > 1)
  let entriesForCaller = try await store.identification(generation: manifest.generation, after: 0)
  #expect(entriesForCaller.map(\.number) == entriesForCaller.map(\.number).sorted())
  #expect(entriesForCaller.first { $0.number == 81_300_000_000 }?.label.isEmpty == false)

  // The save wrote the caller file, and it lists exactly what the store's identification pages list.
  var paged: [IdentificationEntry] = []
  var previous: Int64 = 0
  while true {
    let page = try await store.identification(generation: manifest.generation, after: previous)
    guard let last = page.last else { break }
    paged += page
    previous = last.number
  }
  let saved = await store.callerFile(generation: manifest.generation)
  #expect(
    try CallerFile.active(in: root)
      == CallerFile.Active(generation: manifest.generation, file: saved))
  #expect(try callerEntries(saved) == paged)
  // A directory saved before the caller file existed gets the same file on demand.
  try FileManager.default.removeItem(at: saved)
  #expect(try CallerFile.active(in: root) == nil)
  let rebuilt = try await store.ensureCallerFile(generation: manifest.generation)
  #expect(try callerEntries(rebuilt) == paged)
}

/// Digests every table, the schema, and every file of one saved generation in a fixed order.
private func generationDigests(root: URL, generation: UUID) throws -> [String: String] {
  func file(_ kind: String) throws -> String {
    sha256Hex(try Data(contentsOf: root.appendingPathComponent(generation.uuidString + "." + kind)))
  }
  let database = try SQLiteDatabase(
    url: root.appendingPathComponent(generation.uuidString + ".sqlite"), readOnly: true)
  func table(_ sql: String, row: (OpaquePointer) throws -> [String?]) throws -> String {
    let rows = try database.query(sql) { values in
      try row(values).map { $0.map { "t" + $0 } ?? "n" }.joined(separator: "\u{1F}")
    }
    return "\(rows.count) " + sha256Hex(Data(rows.joined(separator: "\n").utf8))
  }
  let text = { (row: OpaquePointer, column: Int32) in try SQLiteDatabase.optionalText(row, column) }
  let integer = { (row: OpaquePointer, column: Int32) in String(SQLiteDatabase.integer(row, column))
  }
  let stored = try database.query("SELECT value FROM meta WHERE key = 'header'") {
    try SQLiteDatabase.text($0, 0, maximumBytes: 67_108_864)
  }
  let encoder = JSONEncoder()
  encoder.outputFormatting = .sortedKeys
  let header = try encoder.encode(
    JSONDecoder().decode(ArchiveHeader.self, from: Data(try #require(stored.first).utf8)))
  return [
    "schema": try table("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name") {
      [try text($0, 0), try text($0, 1), try text($0, 2), try text($0, 3)]
    },
    "meta": try table("SELECT key FROM meta ORDER BY key") { [try text($0, 0)] },
    "header": sha256Hex(header),
    "categories": try table("SELECT id, label FROM categories ORDER BY id") {
      [integer($0, 0), try text($0, 1)]
    },
    "contacts": try table(
      """
      SELECT id, category, region, name, address, phones, website, provenance, origin, confirmation
      FROM contacts ORDER BY id
      """
    ) { row in
      [integer(row, 0), integer(row, 1)] + (try (2...6).map { try text(row, $0) })
        + [integer(row, 7), try text(row, 8), try text(row, 9)]
    },
    "phones": try table("SELECT number, contact FROM phones ORDER BY number, contact") {
      [integer($0, 0), integer($0, 1)]
    },
    "numbers": try table("SELECT number FROM numbers ORDER BY number") { [integer($0, 0)] },
    "names": try file("names"),
    "kinds": try file("kinds"),
    "callers": try file("callers"),
  ]
}

/// Pins the saved content of the provider fixture, so a faster import can't change what the app saves.
@Test(.timeLimit(.minutes(1))) func providerArchiveSavesTheExpectedGenerationContent()
  async throws
{
  let entries = try corpus("baseline")
  let archive = try #require(entries.first { $0.path.hasSuffix("/directory.tsv.br") })
  let server = try await corpusServer(entries)
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let store = try SnapshotStore(root: root.appendingPathComponent("store"))
  let manifest = try await SyncEngine(api: APIClient(origin: server.origin), store: store)
    .synchronize(progress: { _ in })
  let decoded = try await decodedBrotli(archive.data, in: root)
  let lines = decoded.split(separator: 0x0A, omittingEmptySubsequences: false).dropLast()
  #expect(manifest.records == lines.count - 2)
  var saved: [Data] = []
  while saved.count < manifest.records {
    saved += try await store.archiveRows(
      generation: manifest.generation, from: saved.count,
      count: min(SnapshotStore.archiveRowBatch, manifest.records - saved.count))
  }
  #expect(saved == lines.dropFirst(2).map { Data($0) })
  let digests = try generationDigests(
    root: root.appendingPathComponent("store"), generation: manifest.generation)
  #expect(digests == expectedGenerationDigests)
}

/// The content that the provider fixture's baseline archive saves, as `generationDigests` reports it.
/// Update these only with an intentional change to the corpus or to the saved format.
private let expectedGenerationDigests = [
  "schema": "5 01a5f3b9706aa8a5d5aa4b12e8222d7a59a0bcd19149f8cf951dd0699da2dad9",
  "meta": "1 53aed5e998a4bec4d0ac7ae4c5171d419cb52f0f8cb8c34661ce6eaa2092bcaf",
  "header": "04f50fccfb7c9362da5d7bfea84f241965f1ef165832a23767617f67d73a2dd0",
  "categories": "65 27ffad285ef95cb156028fda743b9cd560948278c0cae43dc21578a7063f2e2d",
  "contacts": "241 0a7235c1eabbff1475d3f258f733902fad8c1593b1daa4873157f0bf76f188b2",
  "phones": "242 b68f529984c2d8a1f4f39943ce0d5aa9a7cf22369bb5f825c3637eb28c350f8d",
  "numbers": "2 eca00b202bc735e58d1f0416753b9423c8ce0ba6532752036beaf042eff65c73",
  "names": "e5b1be0beb6b351f1d186f61dd80bedd77ab5b3b3940e54c96f6ce00bddb163a",
  "kinds": "fd516d49024e15e7e9e2af783a92190b843b3ae99ffede6b8d1e135edf080bc9",
  "callers": "e184b14d93ca6fd6754863e5cd71096dc47f10bfad014961a1fd6241dbae7706",
]

private func callerEntries(_ url: URL) throws -> [IdentificationEntry] {
  let reader = try CallerFile.Reader(url: url)
  var entries: [IdentificationEntry] = []
  while try reader.read(upTo: 1000, { entries.append(IdentificationEntry(number: $0, label: $1)) })
    > 0
  {}
  return entries
}

func decodedBrotli(_ data: Data, in root: URL) async throws -> Data {
  let url = root.appendingPathComponent(UUID().uuidString + ".br")
  try data.write(to: url)
  var text = Data()
  try await BrotliLines(url: url).eachLine { line, _ in
    text += line
    text.append(0x0A)
  }
  return text
}

/// Rebuilds the provider's updated archive from its baseline with the delta that `src/core/directory-delta.ts` wrote.
@Test(.timeLimit(.minutes(1))) func currentProviderDeltaRebuildsTheUpdatedArchive() async throws {
  let updated = try corpus("updated")
  let listingEntry = try #require(updated.first { $0.path.hasPrefix("/api/dataset-deltas?") })
  let listing = try JSONDecoder().decode(DirectoryDeltaListing.self, from: listingEntry.data)
  let delta = try #require(listing.deltas.compactMap(\.entry).first)
  let deltaEntry = try #require(updated.first { $0.path == delta.url })
  let archiveEntry = try #require(updated.first { $0.path.hasSuffix("/directory.tsv.br") })
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let store = try SnapshotStore(root: root.appendingPathComponent("store"))
  let provider = try await corpusServer(corpus("baseline"))
  let baseline = try await SyncEngine(api: APIClient(origin: provider.origin), store: store)
    .synchronize(progress: { _ in })
  #expect(delta.base == baseline.snapshot)
  let deltaFile = root.appendingPathComponent("delta.br")
  try deltaEntry.data.write(to: deltaFile)
  let rebuilt = root.appendingPathComponent("rebuilt")
  let admission = try await DirectoryDeltaApplier(
    url: deltaFile, decodedBytes: delta.uncompressedBytes, target: listing.snapshot,
    targetArchive: listing.archiveSha256
  ).rebuild(from: try await DeltaBase(store: store, manifest: baseline), into: rebuilt)
  #expect(admission == .apply)
  #expect(try Data(contentsOf: rebuilt) == (try await decodedBrotli(archiveEntry.data, in: root)))
  let requests = RequestLog()
  let server = try await corpusServer(updated, requests: requests)
  let manifest = try await SyncEngine(api: APIClient(origin: server.origin), store: store)
    .synchronize(progress: { _ in })
  #expect(manifest.snapshot == listing.snapshot)
  #expect(manifest.previous == baseline.generation)
  let requested = requests.received
  #expect(requested.contains(delta.url))
  #expect(!requested.contains(archiveEntry.path))
}
