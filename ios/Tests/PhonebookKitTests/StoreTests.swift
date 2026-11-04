import Foundation
import PhonebookCore
import Testing

@testable import PhonebookKit

@Test func savedContactsKeepTheirRegionPhonesAndProvenance() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let store = try SnapshotStore(root: root)
  let active = try await publish(
    [
      ArchiveLine(
        name: "千代田図書館", phones: "03-5321-1111\u{1F}0353211112\u{1E}代表",
        website: "https://example.com/", origin: "0", confirmation: "1"),
      ArchiveLine(category: 1, region: "13", name: "都の病院", address: ""),
    ], to: store)
  #expect(active.records == 2)
  let contacts = try await store.contacts(generation: active.generation, ids: [2, 1])
  #expect(contacts.map(\.id) == [2, 1])
  let library = try #require(contacts.last)
  #expect(library.region == "東京都千代田区")
  #expect(library.category == "図書館")
  #expect(library.phones.map(\.display) == ["03-5321-1111", "代表"])
  #expect(library.provenance.sourceURL == "https://example.com/source.csv")
  #expect(library.provenance.publications == ["https://example.com/publication"])
  #expect(library.provenance.confirmationURL == "https://example.com/confirmation")
  #expect(library.provenance.publisher == "試験の公開者")
  #expect(contacts.first?.region == "東京都")
  #expect(try await store.contactIDs(generation: active.generation, number: 81_353_211_112) == [1])
}

@Test func callerEntriesAreSortedAndSharedNumbersHaveOneLabel() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let store = try SnapshotStore(root: root)
  let active = try await publish(
    [
      ArchiveLine(name: "B", phones: "03-0000-0002"),
      ArchiveLine(name: "A", phones: "03-0000-0001"),
      ArchiveLine(name: "C", phones: "03-0000-0001"),
    ], to: store)
  let entries = try await store.identification(generation: active.generation, after: 0)
  #expect(entries.map(\.number) == [81_300_000_001, 81_300_000_002])
  #expect(entries.first?.label == "公共施設（名前が2つあります）")
  #expect(entries.last?.label == "B（図書館）")
  let next = try await store.identification(
    generation: active.generation, after: 81_300_000_001, limit: 1)
  #expect(next == [IdentificationEntry(number: 81_300_000_002, label: "B（図書館）")])
}

@Test func failedOrCancelledImportsKeepTheActiveGeneration() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let store = try SnapshotStore(root: root)
  let active = try await publish([ArchiveLine(name: "保存済み")], to: store)
  let header = try sampleHeader(snapshot: "b", counts: ["13": 2])
  try await store.begin(header: header)
  try await store.append(records([ArchiveLine()], header: header))
  await #expect(throws: ImportError.unexpectedCount) { try await store.publish(at: Date()) }
  try await store.abort()
  #expect(try await store.manifest()?.generation == active.generation)
  let files = try FileManager.default.contentsOfDirectory(atPath: root.path)
  #expect(files.filter { $0.hasSuffix(".names") }.count == 1)
  let concurrent = try SnapshotStore(root: root)
  try await store.begin(header: header)
  await #expect(throws: (any Error).self) { try await concurrent.begin(header: header) }
  try await store.abort()
  #expect(
    try await store.contacts(generation: active.generation, ids: [1]).first?.name == "保存済み")
}

/// A process that stops during an import keeps the active generation, and the next save removes the unfinished files.
@Test func anInterruptedImportKeepsTheActiveGenerationUntilTheNextSaveRemovesIt() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let active = try await publish([ArchiveLine(name: "保存済み")], to: try SnapshotStore(root: root))
  let unfinished = UUID()
  var interrupted: SnapshotStore? = try SnapshotStore(root: root, makeGeneration: { unfinished })
  let header = try sampleHeader(snapshot: "b", counts: ["13": 2])
  try await interrupted?.begin(header: header)
  try await interrupted?.append(records([ArchiveLine()], header: header))
  // Releasing the store closes its files without the cleanup in `abort`, as an ended process does.
  interrupted = nil
  func files(of generation: UUID) throws -> [String] {
    try FileManager.default.contentsOfDirectory(atPath: root.path)
      .filter { $0.hasPrefix(generation.uuidString) }
  }
  #expect(try !files(of: unfinished).isEmpty)
  let store = try SnapshotStore(root: root)
  #expect(try await store.manifest()?.generation == active.generation)
  #expect(try await store.contacts(generation: active.generation, ids: [1]).first?.name == "保存済み")
  let next = try await publish([ArchiveLine(name: "次の施設")], to: store, snapshot: "c")
  #expect(next.previous == active.generation)
  #expect(try files(of: unfinished).isEmpty)
}

@Test func earlierStorageFormatsAreTreatedAsUnsaved() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let legacy = Data(
    """
    {"format":1,"generation":"\(UUID().uuidString)","snapshot":"\(String(repeating: "a", count: 64))",\
    "prefectures":["13"],"updatedAt":0,"records":1,"categories":{}}
    """.utf8)
  try legacy.write(to: root.appendingPathComponent("active.json"))
  let store = try SnapshotStore(root: root)
  #expect(try await store.manifest() == nil)
  try await publish([ArchiveLine()], to: store)
  #expect(try await store.manifest()?.format == SnapshotManifest.currentFormat)
}
