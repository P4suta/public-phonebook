import CSQLite
import Foundation
import PhonebookCore
import Synchronization
import Testing

@testable import PhonebookKit

@Test func aStoreCreatesNestedStorageAndDeclaresItsTransferDirectory() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let nested = root.appendingPathComponent("parent/child/store")
  let store = try SnapshotStore(root: nested)
  #expect(store.transfers.hasDirectoryPath)
  #expect(await store.cleanupPending == false)
  #expect(
    try URL(fileURLWithPath: nested.path).resourceValues(forKeys: [.isExcludedFromBackupKey])
      .isExcludedFromBackup == true)
}

private final class ObservedWriterLease: ReleasableLock {
  private let underlying: WriterLease
  let releases = Mutex(0)
  init(url: URL) throws { underlying = try WriterLease(url: url) }
  func release() {
    releases.withLock { $0 += 1 }
    underlying.release()
  }
}

private final class TransientManifestReadFailure: SnapshotFiles {
  private let first = Mutex(true)
  func readManifest(at url: URL) throws -> Data {
    if first.withLock({ value in
      let result = value
      value = false
      return result
    }) {
      throw ImportError.invalidSnapshot
    }
    return try LocalSnapshotFiles().readManifest(at: url)
  }
  func activateManifest(_ data: Data, at url: URL) throws {
    try LocalSnapshotFiles().activateManifest(data, at: url)
  }
  func removeGeneration(at url: URL) throws { try LocalSnapshotFiles().removeGeneration(at: url) }
}

@Test func failedStorePreparationReleasesItsLeaseBeforeRetrying() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  _ = try await publish([ArchiveLine()], to: SnapshotStore(root: root))
  let observed = Mutex<[ObservedWriterLease]>([])
  let held = HeldLocks()
  defer { held.releaseAll() }
  let store = try SnapshotStore(
    root: root, files: TransientManifestReadFailure(),
    makeLease: { url in
      let lease = try ObservedWriterLease(url: url)
      observed.withLock { $0.append(lease) }
      return lease
    })
  try await HeldLocks.$current.withValue(held) {
    let header = try sampleHeader()
    await #expect(throws: ImportError.invalidSnapshot) { try await store.begin(header: header) }
    let failed = try #require(observed.withLock { $0.first })
    #expect(failed.releases.withLock { $0 } == 1)
    try await store.begin(header: header)
    try await store.append(records([ArchiveLine(name: "Retried")], header: header))
    _ = try await store.publish(at: Date())
  }
  #expect(observed.withLock { $0.count } == 2)
  #expect(held.releaseAll() == 0)
}

@Test func storeOwnersReleaseAndForgetLeasesWhileAnObserverRetainsThem() async throws {
  for commit in [false, true] {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let observed = Mutex<[ObservedWriterLease]>([])
    let held = HeldLocks()
    let store = try SnapshotStore(
      root: root,
      makeLease: { url in
        let lease = try ObservedWriterLease(url: url)
        observed.withLock { $0.append(lease) }
        return lease
      })
    try await HeldLocks.$current.withValue(held) {
      let header = try sampleHeader()
      try await store.begin(header: header)
      try await store.append(records([ArchiveLine()], header: header))
      if commit { _ = try await store.publish(at: Date()) } else { try await store.abort() }
    }
    let lease = try #require(observed.withLock { $0.first })
    #expect(lease.releases.withLock { $0 } == 1)
    #expect(held.releaseAll() == 0)
    let next = try WriterLease(url: root.appendingPathComponent("writer.sqlite"))
    next.release()
  }
}

@Test func aStagingDatabaseHoldsNoAdvisoryFileLock() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let generation = UUID()
  let store = try SnapshotStore(root: root, makeGeneration: { generation })
  try await store.begin(header: sampleHeader())
  let probe = try SQLiteDatabase(
    url: root.appendingPathComponent(generation.uuidString + ".sqlite"), readOnly: false)
  do {
    try probe.execute("PRAGMA busy_timeout = 0")
    try probe.execute("BEGIN EXCLUSIVE")
    try probe.execute("ROLLBACK")
    try probe.close()
  } catch {
    try await store.abort()
    throw error
  }
  try await store.abort()
}

@Test func savedNamesKeepOneIndexLinePerRecord() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let generation = UUID()
  let store = try SnapshotStore(root: root, makeGeneration: { generation })
  let header = try sampleHeader(counts: ["13": 2])
  try await store.begin(header: header)
  try await store.append(
    records([ArchiveLine(name: "A\nB"), ArchiveLine(name: "Next")], header: header))
  #expect(
    try Data(contentsOf: root.appendingPathComponent(generation.uuidString + ".names"))
      == Data("ab\nnext\n".utf8))
  try await store.abort()
}

@Test func sharedCallerNamesPreserveEveryDistinctCategory() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let store = try SnapshotStore(root: root)
  let manifest = try await publish(
    [ArchiveLine(name: "Shared"), ArchiveLine(category: 1, name: "Shared")], to: store)
  let entries = try await store.identification(generation: manifest.generation, after: 0)
  #expect(entries.map(\.label) == ["Shared（図書館・病院・診療所）"])
}

@Test func sharedCallerProjectionAcceptsItsLimitAndRejectsOneMoreRow() async throws {
  for count in [4096, 4097] {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try SnapshotStore(root: root)
    let header = try sampleHeader(counts: ["13": count])
    try await store.begin(header: header)
    try await store.append(
      records(Array(repeating: ArchiveLine(name: "Shared"), count: count), header: header))
    if count == 4096 {
      let saved = try await store.publish(at: Date())
      #expect(
        try await store.identification(generation: saved.generation, after: 0).map(\.label)
          == ["Shared（図書館）"])
    } else {
      await #expect(throws: ImportError.projectionTooLarge) { try await store.publish(at: Date()) }
      #expect(try await store.manifest() == nil)
      try await store.abort()
    }
  }
}

@Test func contactReadsAcceptFiveHundredIDsAndRejectTheNext() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let store = try SnapshotStore(root: root)
  let manifest = try await publish((0..<500).map { ArchiveLine(name: "Row\($0)") }, to: store)
  let ids = Array((1...500).reversed()).map { Int64($0) }
  #expect(try await store.contacts(generation: manifest.generation, ids: ids).map(\.id) == ids)
  #expect(try await store.contacts(generation: manifest.generation, ids: []).isEmpty)
  await #expect(throws: ImportError.invalidRecord) {
    try await store.contacts(generation: manifest.generation, ids: ids + [1])
  }
}

@Test func storedPhoneFieldsPreserveEmptyFieldsAndOnlySplitAtTheFirstMarker() throws {
  for (text, number, display) in [
    ("number\u{1E}label", "number", "label"), ("number\u{1E}", "number", ""),
    ("\u{1E}label", "", "label"), ("number\u{1E}a\u{1E}b", "number", "a\u{1E}b"),
  ] {
    let fields = try SnapshotStore.phoneFields(text[...])
    #expect(fields.e164 == number && fields.display == display)
  }
  for text in ["", "number"] {
    #expect(throws: ImportError.invalidRecord) { try SnapshotStore.phoneFields(text[...]) }
  }
  #expect(SnapshotStore.numberingDuration(total: .seconds(10), writing: .seconds(3)) == .seconds(7))
  #expect(
    SnapshotStore.numberingDuration(total: .nanoseconds(100), writing: .nanoseconds(99))
      == .nanoseconds(1))
  #expect(SnapshotStore.numberingDuration(total: .zero, writing: .zero) == .zero)
}

@Test func archiveRowSlicesRejectOverflowBeforeOpeningAGeneration() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let store = try SnapshotStore(root: root)
  let generation = UUID()
  for (start, count) in [(Int.max, 1), (Int.max - 4095, 4096)] {
    await #expect(throws: ImportError.invalidRecord) {
      try await store.archiveRows(generation: generation, from: start, count: count)
    }
  }
  await #expect(throws: ImportError.unavailableStorage) {
    try await store.archiveRows(generation: generation, from: Int.max - 4096, count: 4096)
  }
}

@Test func callerLabelsAcceptExactlyOneThousandTwentyFourUTF8Bytes() async throws {
  for length in [1024, 1025] {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try SnapshotStore(root: root)
    let suffix = "（図書館）"
    let name = String(repeating: "a", count: length - suffix.utf8.count)
    let header = try sampleHeader()
    try await store.begin(header: header)
    try await store.append(records([ArchiveLine(name: name)], header: header))
    if length == 1024 {
      let saved = try await store.publish(at: Date())
      #expect(
        try await store.identification(generation: saved.generation, after: 0).first?.label
          == name + suffix)
    } else {
      await #expect(throws: ImportError.projectionTooLarge) { try await store.publish(at: Date()) }
      try await store.abort()
    }
  }
}

@Test func appendingPastTheDeclaredRowCountFailsBeforeSavingAnyRow() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let store = try SnapshotStore(root: root)
  let header = try sampleHeader()
  try await store.begin(header: header)
  await #expect(throws: ImportError.unexpectedCount) {
    try await store.append(
      records([ArchiveLine(name: "One"), ArchiveLine(name: "Two")], header: header))
  }
  try await store.append(records([ArchiveLine(name: "Accepted")], header: header))
  let saved = try await store.publish(at: Date())
  #expect(saved.records == 1)
}

@Test func callerNumberingChecksCancellationOncePerFourThousandNinetySixRows() async throws {
  for cancel in [false, true] {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let checks = Mutex(0)
    let store = try SnapshotStore(
      root: root, makeLease: { try WriterLease(url: $0) },
      checkNumberingCancellation: {
        checks.withLock { $0 += 1 }
        if cancel { throw CancellationError() }
      })
    let lines = (0..<4097).map {
      ArchiveLine(name: "Row\($0)", phones: "090" + String(format: "%08d", $0))
    }
    let header = try sampleHeader(counts: ["13": lines.count])
    try await store.begin(header: header)
    try await store.append(records(lines, header: header))
    if cancel {
      await #expect(throws: CancellationError.self) { try await store.publish(at: Date()) }
      #expect(try await store.manifest() == nil)
      try await store.abort()
    } else {
      #expect(try await store.publish(at: Date()).records == 4097)
    }
    #expect(checks.withLock { $0 } == 1)
  }
}

@Test func publishedGenerationConnectionsRejectWritesThroughSQLite() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let saved = try await publish([ArchiveLine()], to: SnapshotStore(root: root))
  let statuses = Mutex<[Int32]>([])
  let reader = try SnapshotStore(
    root: root, makeLease: { try WriterLease(url: $0) },
    openReader: { url, readOnly in
      let database = try SQLiteDatabase(url: url, readOnly: readOnly)
      let status: Int32
      do {
        try database.execute("UPDATE contacts SET name = name WHERE id = 1")
        status = SQLITE_OK
      } catch DatabaseError.sqlite(let code, _) {
        status = code
      }
      statuses.withLock { $0.append(status) }
      return database
    })
  #expect(try await reader.contacts(generation: saved.generation, ids: [1]).count == 1)
  #expect(statuses.withLock { $0 } == [SQLITE_READONLY])
}
