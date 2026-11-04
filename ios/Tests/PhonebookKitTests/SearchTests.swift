import Foundation
import PhonebookCore
import Testing

@testable import PhonebookKit

private func index(_ lines: [ArchiveLine]) async throws -> (LocalSearch, SnapshotStore, UUID, URL) {
  let root = try temporaryDirectory()
  let store = try SnapshotStore(root: root)
  let active = try await publish(lines, to: store)
  return (
    try await store.searchIndex(generation: active.generation), store, active.generation, root
  )
}

@Test func localSearchRanksLikeTheWebsite() async throws {
  let lines = [
    ArchiveLine(name: "中央図書館"), ArchiveLine(name: "図書館"), ArchiveLine(name: "図書館分室"),
    ArchiveLine(category: 1, name: "図書館前クリニック"), ArchiveLine(name: "公民館"),
    ArchiveLine(name: "ＴＯＳＨＯ Library"),
  ]
  let (search, store, generation, root) = try await index(lines)
  defer { try? FileManager.default.removeItem(at: root) }
  let groups = try search.search(SearchInput.words("図書館"))
  #expect(groups.count == 2)
  let names = { (group: [LocalSearch.Match]) async throws -> [String] in
    try await store.contacts(generation: generation, ids: group.map(\.id)).map(\.name)
  }
  // The library category's label holds the word, so the category's other rows follow every name match.
  #expect(
    try await names(groups[0]) == ["図書館", "図書館分室", "中央図書館", "ＴＯＳＨＯ Library", "公民館"])
  #expect(groups[0].map(\.rank) == [.exact, .prefix, .substring, .place, .place])
  #expect(try await names(groups[1]) == ["図書館前クリニック"])
  #expect(try search.search(SearchInput.words("tosho")).count == 1)
  #expect(try search.search(["館\n公"]).isEmpty)
  #expect(try search.search([]).isEmpty)
  #expect(try search.search(["見つからない"]).isEmpty)
}

@Test func localSearchMatchesEveryWordInTheNameRegionOrCategory() async throws {
  let lines = [
    ArchiveLine(name: "市川市中央図書館"), ArchiveLine(region: "13", name: "中央図書館"),
    ArchiveLine(category: 1, name: "中央クリニック"), ArchiveLine(region: "14", name: "センター"),
    ArchiveLine(region: "14100", name: "市ヶ谷会館"),
  ]
  let (search, store, generation, root) = try await index(lines)
  defer { try? FileManager.default.removeItem(at: root) }
  func found(_ query: String) async throws -> [[String]] {
    var result: [[String]] = []
    for group in try search.search(SearchInput.words(query)) {
      result.append(
        try await store.contacts(generation: generation, ids: group.map(\.id)).map(\.name))
    }
    return result
  }
  #expect(try await found("市川 図書館") == [["市川市中央図書館"]])
  #expect(try await found("千代田\u{3000}\u{3000}中央") == [["中央クリニック"], ["市川市中央図書館"]])
  #expect(try await found("東京 図書館") == [["中央図書館", "市川市中央図書館"]])
  #expect(try await found("病院 中央") == [["中央クリニック"]])
  #expect(try await found("県14") == [["センター", "市ヶ谷会館"]])
  #expect(try await found("せんた-") == [["センター"]])
  #expect(try await found("市ケ谷") == [["市ヶ谷会館"]])
  #expect(try await found("千代田 県14").isEmpty)
}

@Test func phoneMatchesGroupEveryRecordForTheNumber() async throws {
  let lines = [
    ArchiveLine(name: "B", phones: "03-0000-0001"), ArchiveLine(name: "A", phones: "03-0000-0001"),
    ArchiveLine(category: 1, name: "C", phones: "03-0000-0001"),
    ArchiveLine(name: "D", phones: "03-0000-0002"),
  ]
  let (search, store, generation, root) = try await index(lines)
  defer { try? FileManager.default.removeItem(at: root) }
  let ids = try await store.contactIDs(generation: generation, number: 81_300_000_001)
  let groups = try search.exact(ids)
  #expect(groups.map(\.count) == [2, 1])
  let first = try await store.contacts(generation: generation, ids: groups[0].map(\.id))
  #expect(first.map(\.name) == ["A", "B"])
}

@MainActor @Test func directoryModelShowsPreviewsAndMore() async throws {
  let lines = (0..<60).map { ArchiveLine(name: "図書館" + String(format: "%02d", $0)) }
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let store = try SnapshotStore(root: root)
  let active = try await publish(lines, to: store)
  let model = DirectoryModel(store: store)
  await model.activate(active)
  model.query = "図書館"
  await model.search()?.value
  let group = try #require(model.results?.groups.first)
  #expect(group.total == 60)
  #expect(model.visible(group).map(\.name) == ["図書館00", "図書館01", "図書館02"])
  await model.more(group)?.value
  #expect(model.expanded(group))
  #expect(model.visible(group).count == 53)
  model.query = "  "
  #expect(model.search() == nil)
  #expect(model.results == nil)
}

@MainActor @Test func searchResultsNameTheTypedQueryTheyAnswer() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let store = try SnapshotStore(root: root)
  let active = try await publish([ArchiveLine(name: "図書館")], to: store)
  let model = DirectoryModel(store: store)
  await model.activate(active)
  model.query = "ＴＯＳＨＯ"
  await model.search()?.value
  #expect(model.results?.query == "tosho")
  #expect(model.results?.input == "ＴＯＳＨＯ")
  model.query = "ＴＯＳＨＯ "
  await model.search()?.value
  #expect(model.results?.input == "ＴＯＳＨＯ ")
  model.query = "図書館"
  await model.search()?.value
  #expect(model.results?.input == "図書館")
  #expect(model.results?.total == 1)
}
