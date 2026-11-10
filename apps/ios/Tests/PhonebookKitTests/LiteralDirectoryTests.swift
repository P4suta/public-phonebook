import Foundation
import PhonebookCore
import Testing

@testable import PhonebookKit

private func literalDirectory(root: URL, lines: [ArchiveLine]) async throws
  -> (SnapshotStore, SnapshotManifest)
{
  let store = try SnapshotStore(root: root.appendingPathComponent("store"))
  return (store, try await publish(lines, to: store))
}

@MainActor private func shownNames(_ model: DirectoryModel) -> [[String]] {
  model.results?.groups.map { model.visible($0).map(\.name) } ?? []
}

@Test func savedLiteralDirectoryOpensWithoutExperimentalCompanions() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, saved) = try await literalDirectory(root: root, lines: [ArchiveLine(name: "Saved")])
  let opened = try #require(try await store.manifest())
  #expect(opened.generation == saved.generation && opened.snapshot == saved.snapshot)
  #expect(try await store.contacts(generation: saved.generation, ids: [1]).map(\.name) == ["Saved"])
  let directory = await store.root
  #expect(try CallerFile.active(in: directory)?.generation == saved.generation)
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

private enum DirectoryFault: Sendable {
  case unavailable, cancelled

  func raise() throws {
    switch self {
    case .unavailable: throw ImportError.unavailableStorage
    case .cancelled: throw CancellationError()
    }
  }
}

private actor DelayedDirectory: DirectorySearchSource {
  let base: SnapshotStore
  private var contactsGate: SearchGate?
  private var headerGate: SearchGate?
  private var omit = false
  private var headerFault: DirectoryFault?
  private var contactsFault: DirectoryFault?
  private(set) var headerCalls: [UUID] = []
  private(set) var contactCalls = 0

  init(_ base: SnapshotStore) { self.base = base }
  func holdContacts(_ gate: SearchGate) { contactsGate = gate }
  func holdHeader(_ gate: SearchGate) { headerGate = gate }
  func omitOneContact() { omit = true }
  func failHeader(_ fault: DirectoryFault) { headerFault = fault }
  func failContacts(_ fault: DirectoryFault) { contactsFault = fault }
  func changedManifest() async throws -> SnapshotManifest {
    try await publish([ArchiveLine(name: "Changed")], to: base, snapshot: "b")
  }

  func header(generation: UUID) async throws -> ArchiveHeader {
    headerCalls.append(generation)
    let fault = headerFault
    headerFault = nil
    if let gate = headerGate {
      headerGate = nil
      await gate.pause()
    }
    try fault?.raise()
    return try await base.header(generation: generation)
  }
  func searchIndex(generation: UUID) async throws -> LocalSearch {
    try await base.searchIndex(generation: generation)
  }
  func contactIDs(generation: UUID, number: Int64) async throws -> [Int64] {
    try await base.contactIDs(generation: generation, number: number)
  }
  func contacts(generation: UUID, ids: [Int64]) async throws -> [Contact] {
    contactCalls += 1
    let fault = contactsFault
    contactsFault = nil
    if let gate = contactsGate {
      contactsGate = nil
      await gate.pause()
    }
    try fault?.raise()
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
  try #require(model.searching)
  await gate.waitForEntry()
  model.query = "B"
  await model.search()?.value
  #expect(old?.isCancelled == true)
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
  try #require(model.loadingMore)
  await oldGate.waitForEntry()
  model.query = "B"
  await model.search()?.value
  #expect(old?.isCancelled == true)
  let group = try #require(model.results?.groups.first)
  await source.holdContacts(currentGate)
  let current = model.more(group)
  try #require(model.loadingMore)
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
  #expect(!model.searching)
  await model.retry()?.value
  #expect(!model.failed)
  #expect(model.results?.input == "A")
}

@MainActor @Test func telephoneResultsGroupEveryCategoryInNameOrder() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, saved) = try await literalDirectory(
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

@MainActor @Test func directoryActivationResetsStateAndStartsTheTypedQuery() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let (source, saved) = try await delayedDirectory(root: root)
  let model = DirectoryModel(store: source)
  #expect(!model.loading && !model.searching && !model.loadingMore && !model.failed)
  #expect(!model.ready && model.results == nil && model.generation == nil)
  let header = SearchGate()
  let contacts = SearchGate()
  defer {
    Task {
      await header.release()
      await contacts.release()
    }
  }
  await source.holdHeader(header)
  await source.holdContacts(contacts)
  model.query = "A"
  let activation = Task { await model.activate(saved) }
  await header.waitForEntry()
  #expect(model.loading && !model.searching && !model.loadingMore && !model.failed)
  #expect(model.generation == saved.generation && !model.ready && model.results == nil)
  await header.release()
  await activation.value
  try #require(model.searching)
  #expect(!model.loading && !model.loadingMore && !model.failed && model.ready)
  await contacts.waitForEntry()
  await contacts.release()
  await model.search()?.value
  #expect(model.results?.input == "A" && !model.failed && !model.searching)
  let calls = await source.headerCalls
  await model.activate(saved)
  #expect(await source.headerCalls == calls)
  let changed = try await source.changedManifest()
  await model.activate(changed)
  await model.search()?.value
  #expect(model.generation == changed.generation && model.ready)
  #expect(await source.headerCalls == calls + [changed.generation])
  await model.activate(nil)
  #expect(!model.ready && model.generation == nil && model.results == nil)
  #expect(!model.loading && !model.searching && !model.loadingMore && !model.failed)
  #expect(model.categories.isEmpty && model.shown.isEmpty)
}

@MainActor @Test func activationFailuresRetryAndIgnoreSupersededFailures() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let (source, saved) = try await delayedDirectory(root: root)
  let model = DirectoryModel(store: source)
  await source.failHeader(.unavailable)
  await model.activate(saved)
  #expect(model.failed && !model.loading && !model.ready)
  await model.retry()?.value
  #expect(model.ready && !model.failed && !model.loading)
  await model.activate(nil)
  await source.failHeader(.cancelled)
  await model.activate(saved)
  #expect(!model.failed && !model.loading && !model.ready)

  let gate = SearchGate()
  defer { Task { await gate.release() } }
  await source.holdHeader(gate)
  await source.failHeader(.unavailable)
  let obsolete = Task { await model.activate(saved) }
  await gate.waitForEntry()
  let changed = try await source.changedManifest()
  await model.activate(changed)
  #expect(model.generation == changed.generation && model.ready && !model.failed)
  await gate.release()
  await obsolete.value
  #expect(model.generation == changed.generation && model.ready && !model.failed)
  #expect(!model.loading)
}

@MainActor @Test func deactivationCancelsOutstandingSearchAndPageTasks() async throws {
  for paging in [false, true] {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let (source, saved) = try await delayedDirectory(root: root)
    let model = DirectoryModel(store: source)
    await model.activate(saved)
    model.query = "A"
    if paging { await model.search()?.value }
    let gate = SearchGate()
    defer { Task { await gate.release() } }
    await source.holdContacts(gate)
    let task = paging ? model.more(try #require(model.results?.groups.first)) : model.search()
    try #require(paging ? model.loadingMore : model.searching)
    await gate.waitForEntry()
    await model.activate(nil)
    #expect(task?.isCancelled == true)
    #expect(!model.loadingMore && !model.searching && !model.failed && model.results == nil)
    await gate.release()
    await task?.value
    #expect(!model.loadingMore && !model.searching && !model.failed && model.results == nil)
  }
}

@MainActor @Test func searchAndPageFailuresSetOnlyTheCurrentFailureState() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let (source, saved) = try await delayedDirectory(root: root)
  let model = DirectoryModel(store: source)
  await model.activate(saved)
  model.query = "A"
  await source.failContacts(.unavailable)
  await model.search()?.value
  #expect(model.failed && !model.searching && !model.loadingMore && model.results == nil)
  model.query = "B"
  await source.failContacts(.cancelled)
  await model.search()?.value
  #expect(!model.failed && !model.searching && !model.loadingMore && model.results == nil)
  model.query = " \n\t"
  #expect(model.search() == nil)
  #expect(!model.failed && !model.searching && !model.loadingMore && model.results == nil)
  model.query = "A"
  await model.search()?.value
  let group = try #require(model.results?.groups.first)
  await source.failContacts(.unavailable)
  await model.more(group)?.value
  #expect(model.failed && !model.loadingMore && !model.expanded(group))
  await model.retry()?.value
  #expect(!model.failed && !model.searching)
  await source.failContacts(.cancelled)
  await model.more(try #require(model.results?.groups.first))?.value
  #expect(!model.failed && !model.loadingMore && !model.expanded(group))

  let gate = SearchGate()
  defer { Task { await gate.release() } }
  await source.holdContacts(gate)
  await source.failContacts(.unavailable)
  let obsolete = model.more(try #require(model.results?.groups.first))
  try #require(model.loadingMore)
  await gate.waitForEntry()
  model.query = "B"
  let current = model.search()
  #expect(!model.loadingMore && model.searching && !model.failed)
  #expect(model.visible(group).isEmpty)
  await current?.value
  #expect(!model.failed && !model.searching)
  await gate.release()
  await obsolete?.value
  #expect(!model.failed && !model.loadingMore && model.results?.input == "B")
}
