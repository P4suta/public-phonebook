import Foundation
import PhonebookCore
import Testing

@testable import PhonebookKit

@Test @MainActor func watchSearchKeepsThePhoneQueryAndBoundsItsResultPage() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let store = try SnapshotStore(root: root)
  let manifest = try await publish((0..<15).map { ArchiveLine(name: "図書館 \($0)") }, to: store)
  let phone = DirectoryModel(store: store)
  await phone.activate(manifest)
  phone.query = "保存した検索"
  await phone.search()?.value
  let request = try WatchSearchRequest(id: UUID(), query: "としょかん")
  let reply = try await WatchDirectorySearch(store: store).search(request)
  #expect(reply.requestID == request.id)
  #expect(reply.state == .ready)
  #expect(reply.total == 15)
  #expect(reply.results.count == 10)
  #expect(phone.query == "保存した検索")
  #expect(reply.results.first?.publisher == "試験の公開者")
  #expect(reply.results.first?.sourceURL == "https://example.com/source.csv")
  #expect(reply.results.first?.licenseURL == "https://example.com/license")
  #expect(reply.results.first?.numbers == ["+81353211111"])
}

@Test func watchSearchUsesTheCurrentSavedGeneration() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let store = try SnapshotStore(root: root)
  let search = WatchDirectorySearch(store: store)
  let request = try WatchSearchRequest(id: UUID(), query: "図書館")
  #expect(try await search.search(request).state == .needsPreparation)
  try await publish([ArchiveLine(name: "旧図書館")], to: store)
  #expect(try await search.search(request).results.map(\.name) == ["旧図書館"])
  try await publish([ArchiveLine(name: "更新図書館")], to: store, snapshot: "b")
  #expect(try await search.search(request).results.map(\.name) == ["更新図書館"])
}

@Test func watchSearchFindsCompleteNumbersAndEmptyResults() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let store = try SnapshotStore(root: root)
  try await publish(
    [ArchiveLine(name: "第一図書館"), ArchiveLine(category: 1, name: "病院")], to: store)
  let search = WatchDirectorySearch(store: store)
  let number = try WatchSearchRequest(id: UUID(), query: "０３（５３２１）１１１１")
  let reply = try await search.search(number)
  #expect(reply.total == 2)
  #expect(Set(reply.results.map(\.name)) == ["第一図書館", "病院"])
  let empty = try await search.search(WatchSearchRequest(id: UUID(), query: "zzzzzz"))
  #expect(empty.state == .ready)
  #expect(empty.results.isEmpty)
  #expect(empty.total == 0)
}
