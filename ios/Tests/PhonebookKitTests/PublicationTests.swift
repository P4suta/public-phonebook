import Foundation
import PhonebookCore
import PhonebookRanking
import Synchronization
import Testing

@testable import PhonebookKit

private enum FileFault: Error, Sendable {
  case beforeActivation, afterActivation, unreadableAfterActivation, unreadable, cleanup
}

private final class FaultSnapshotFiles: SnapshotFiles {
  private let fault = Mutex<FileFault?>(nil)
  private let local = LocalSnapshotFiles()

  func failNext(_ value: FileFault) { fault.withLock { $0 = value } }
  func recover() { fault.withLock { $0 = nil } }

  private func take(_ expected: FileFault) -> Bool {
    fault.withLock {
      guard $0 == expected else { return false }
      $0 = nil
      return true
    }
  }

  func readManifest(at url: URL) throws -> Data {
    if fault.withLock({ $0 == .unreadable }) { throw FileFault.unreadable }
    return try local.readManifest(at: url)
  }

  func activateManifest(_ data: Data, at url: URL) throws {
    if take(.beforeActivation) { throw FileFault.beforeActivation }
    try local.activateManifest(data, at: url)
    if take(.unreadableAfterActivation) {
      failNext(.unreadable)
      throw FileFault.afterActivation
    }
    if take(.afterActivation) { throw FileFault.afterActivation }
  }

  func removeGeneration(at url: URL) throws {
    if take(.cleanup) { throw FileFault.cleanup }
    try local.removeGeneration(at: url)
  }
}

@Test func anUnknownActivationOutcomeRetainsItsDatabaseUntilRecovery() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let files = FaultSnapshotFiles()
  let store = try SnapshotStore(root: root, files: files)
  try await stage(store, id: "uncertain")
  files.failNext(.unreadableAfterActivation)
  await #expect(throws: ImportError.activationUncertain) { try await commit(store) }
  try await store.abort()
  files.recover()
  let active = try #require(try await store.manifest())
  #expect(
    try await firstName(store, active.generation)
      == "uncertain")
  let restarted = try SnapshotStore(root: root)
  try await stage(restarted, id: "recovered")
  _ = try await commit(restarted)
}

private func stage(_ store: SnapshotStore, id: String) async throws {
  let header = try sampleHeader()
  try await store.begin(header: header)
  try await store.append(records([ArchiveLine(name: id)], header: header))
}

private func commit(_ store: SnapshotStore) async throws -> SnapshotManifest {
  try await store.publish(at: Date())
}

private func firstName(_ store: SnapshotStore, _ generation: UUID) async throws -> String? {
  try await store.contacts(generation: generation, ids: [1]).first?.name
}

@Test func interruptedSearchRemovalKeepsTheDirectoryAndRetries() async throws {
  for fault: FileFault in [
    .beforeActivation, .afterActivation, .unreadableAfterActivation, .cleanup,
  ] {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let files = FaultSnapshotFiles()
    let store = try SnapshotStore(root: root.appendingPathComponent("store"), files: files)
    let header = try sampleHeader()
    let lines = [ArchiveLine(name: "Saved")]
    let artifacts = try searchFixture(in: root, header: header, lines: lines)
    try await store.begin(header: header, requiresRankedSearch: true)
    try await store.append(records(lines, header: header))
    try await store.installSearch(artifacts)
    let saved = try await store.publish(at: Date())
    files.failNext(fault)
    await #expect(throws: (any Error).self) { try await store.removeSearchArtifacts() }
    files.recover()
    #expect(try await store.manifest()?.generation == saved.generation)
    try await store.removeSearchArtifacts()
    #expect(try await store.manifest()?.rankedSearch == nil)
    #expect(try await firstName(store, saved.generation) == "Saved")
    #expect(try await CallerFile.active(in: store.root)?.generation == saved.generation)
  }
}

@Test func literalSearchCleanupDoesNotContendWithAnotherImport() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let store = try SnapshotStore(root: root)
  let saved = try await publish([ArchiveLine(name: "Saved")], to: store)
  let importing = try SnapshotStore(root: root)
  try await importing.begin(header: sampleHeader(snapshot: "b"))
  do {
    try await store.removeSearchArtifacts()
  } catch {
    try await importing.abort()
    throw error
  }
  try await importing.abort()
  #expect(try await store.manifest()?.generation == saved.generation)
}

@Test func failedRankedActivationKeepsThePreviousSearchAndCallerGeneration() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let files = FaultSnapshotFiles()
  let directory = root.appendingPathComponent("store")
  let store = try SnapshotStore(root: directory, files: files)
  func stageRanked(_ name: String) async throws {
    let header = try sampleHeader()
    let lines = [ArchiveLine(name: name)]
    let artifacts = try searchFixture(in: root, header: header, lines: lines)
    try await store.begin(header: header, requiresRankedSearch: true)
    try await store.append(records(lines, header: header))
    try await store.installSearch(artifacts)
  }
  try await stageRanked("Saved")
  let original = try await commit(store)
  try await stageRanked("Rejected")
  files.failNext(.beforeActivation)
  await #expect(throws: FileFault.self) { try await commit(store) }
  try await store.abort()
  #expect(try await store.manifest()?.generation == original.generation)
  #expect(try CallerFile.active(in: directory)?.generation == original.generation)
  let search = try #require(try await store.rankedSearch(generation: original.generation))
  #expect(try search.search("Saved").map(\.id) == [1])
  let remaining = try FileManager.default.contentsOfDirectory(atPath: directory.path)
    .filter { $0.hasSuffix(".search.json") }
  #expect(remaining == [original.generation.uuidString + ".search.json"])
}

@Test func cancelledSearchAdmissionKeepsTheActiveGenerationAndRemovesTheDraft() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let directory = root.appendingPathComponent("store")
  let store = try SnapshotStore(root: directory)
  let original = try await publish([ArchiveLine(name: "Saved")], to: store)
  let header = try sampleHeader(snapshot: "b")
  let lines = [ArchiveLine(name: "Staging")]
  let artifacts = try searchFixture(in: root, header: header, lines: lines)
  try await store.begin(header: header, requiresRankedSearch: true)
  try await store.append(records(lines, header: header))
  let operation = Task {
    withUnsafeCurrentTask { $0?.cancel() }
    try await store.installSearch(artifacts)
  }
  await #expect(throws: CancellationError.self) { try await operation.value }
  try await store.abort()
  #expect(try await store.manifest()?.generation == original.generation)
  #expect(try await firstName(store, original.generation) == "Saved")
  #expect(
    try FileManager.default.contentsOfDirectory(atPath: directory.path).allSatisfy {
      !$0.hasSuffix(".search.json")
    })
}

@Test func failedActivationKeepsBothReadableGenerationsAndAllowsRecovery() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let files = FaultSnapshotFiles()
  let store = try SnapshotStore(root: root, files: files)
  try await stage(store, id: "first")
  let first = try await commit(store)
  try await stage(store, id: "second")
  let second = try await commit(store)
  try await stage(store, id: "failed")
  files.failNext(.beforeActivation)
  await #expect(throws: FileFault.self) { try await commit(store) }
  try await store.abort()
  #expect(try await store.manifest()?.generation == second.generation)
  #expect(
    try await firstName(store, first.generation) == "first"
  )
  try await stage(store, id: "recovered")
  let recovered = try await commit(store)
  #expect(
    try await firstName(store, recovered.generation)
      == "recovered")
}

@Test func anActivationErrorAfterTheAtomicWriteCannotDeleteTheCommittedDatabase() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let files = FaultSnapshotFiles()
  let store = try SnapshotStore(root: root, files: files)
  try await stage(store, id: "committed")
  files.failNext(.afterActivation)
  let active = try await commit(store)
  try await store.abort()
  #expect(try await store.manifest()?.generation == active.generation)
  #expect(
    try await firstName(store, active.generation)
      == "committed")
}

@Test func failedCleanupDoesNotTurnACommittedUpdateIntoFailure() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let files = FaultSnapshotFiles()
  let store = try SnapshotStore(root: root, files: files)
  for id in ["first", "second"] {
    try await stage(store, id: id)
    _ = try await commit(store)
  }
  try await stage(store, id: "committed")
  files.failNext(.cleanup)
  let active = try await commit(store)
  #expect(try await store.manifest()?.generation == active.generation)
  try await stage(store, id: "next")
  _ = try await commit(store)
  let databases = try FileManager.default.contentsOfDirectory(atPath: root.path)
    .filter { $0.hasSuffix(".sqlite") && $0 != "writer.sqlite" }
  #expect(databases.count == 2)
}
