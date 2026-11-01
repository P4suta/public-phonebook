import Foundation
import PhonebookCore
import Testing

@testable import PhonebookKit

private struct CorpusEntry: Decodable {
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

private func corpus() throws -> [CorpusEntry] {
  let url = try #require(Bundle.module.url(forResource: "DirectoryContract", withExtension: "json"))
  return try JSONDecoder().decode([CorpusEntry].self, from: Data(contentsOf: url))
}

/// Serves the responses that the merged producer wrote for the shared provider corpus.
private func corpusServer(_ entries: [CorpusEntry]) async throws -> HTTPTestServer {
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
    return responses[target]
      ?? Data("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".utf8)
  }
}

@Test(.timeLimit(.minutes(1))) func currentProviderArchiveImportsTheNationalDirectory()
  async throws
{
  let entries = try corpus()
  let listing = try #require(entries.first { $0.path.hasPrefix("/api/v1/datasets?") })
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
}
