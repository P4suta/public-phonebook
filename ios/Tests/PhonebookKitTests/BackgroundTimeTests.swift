import Darwin
import Foundation
import PhonebookCore
import Testing

@testable import PhonebookKit

/// Records the background tasks that a runner begins and ends, and lets a test expire them as iOS would.
@MainActor
private final class TestBackgroundTime: BackgroundTimePort {
  private(set) var begun: [String] = []
  private(set) var ended: [Int] = []
  private var expiries: [@MainActor @Sendable () -> Void] = []

  func begin(name: String, expire: @escaping @MainActor @Sendable () -> Void) -> Int {
    begun.append(name)
    expiries.append(expire)
    return begun.count
  }

  func end(_ assertion: Int) { ended.append(assertion) }

  func expire() { for expiry in expiries { expiry() } }
}

/// Holds a progress report until the test opens it.
private actor Gate {
  private var open = false
  private var waiting: [CheckedContinuation<Void, Never>] = []

  func wait() async {
    if open { return }
    await withCheckedContinuation { waiting.append($0) }
  }

  func release() {
    open = true
    for continuation in waiting { continuation.resume() }
    waiting.removeAll()
  }
}

/// An archive of three record batches and its listing.
private struct Directory {
  static let rows = 3_000
  let snapshot: String
  let archive: Data
  let file: String
  let listing: Data

  init() throws {
    snapshot = try sampleSnapshot().rawValue
    let lines = (0..<Self.rows).map {
      ArchiveLine(name: "図書館\($0) \(UInt64($0) &* 0x9E37_79B9)")
    }
    archive = try brotli(
      archiveText(header: sampleHeaderObject(counts: ["13": Self.rows]), lines: lines))
    let digest = sha256Hex(archive)
    file = "/api/datasets/\(snapshot)/\(digest)/directory.tsv.br"
    listing = datasetsFixture(
      snapshot: snapshot, contacts: Self.rows, sha256: digest, bytes: archive.count, url: file)
  }

  /// Serves the listing and the archive, and with `cut` sends that many archive bytes and keeps the connection open.
  func serve(cut: Int? = nil) async throws -> HTTPTestServer {
    try await HTTPTestServer(finish: cut == nil) { [self] request in
      let target = request.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
      if target == "/api/datasets" {
        return httpResponse(
          listing,
          headers: "Content-Length: \(listing.count)\r\nX-Dataset-Snapshot: \(snapshot)\r\n")
      }
      guard target == file else { return notFoundResponse }
      return Data(
        "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: application/octet-stream\r\nX-Dataset-Snapshot: \(snapshot)\r\nContent-Length: \(archive.count)\r\n\r\n"
          .utf8) + archive.prefix(cut ?? archive.count)
    }
  }
}

/// Whether this process can take the transfer lock that a download holds while it receives a file.
private func transferLockIsFree(_ store: SnapshotStore) -> Bool {
  let descriptor = open(
    store.transfers.appendingPathComponent("transfer.lock").path, O_RDWR | O_CLOEXEC)
  guard descriptor >= 0 else { return false }
  defer { close(descriptor) }
  guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else { return false }
  flock(descriptor, LOCK_UN)
  return true
}

@Test(.timeLimit(.minutes(1))) @MainActor
func expiryCancelsATransferAndReleasesItsLock() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let directory = try Directory()
  let cut = directory.archive.count / 2
  let server = try await directory.serve(cut: cut)
  let store = try SnapshotStore(root: root)
  let engine = SyncEngine(api: try APIClient(origin: server.origin), store: store)
  let port = TestBackgroundTime()
  let (received, reached) = AsyncStream.makeStream(of: Void.self)
  let run = Task { @MainActor in
    try await BackgroundTimeRunner.run(port, name: "synchronize") {
      try await engine.synchronize { report in
        if report.stage == SyncProgress.transfer, report.done >= cut { reached.yield() }
      }
    }
  }
  for await _ in received { break }
  #expect(port.begun == ["synchronize"])
  #expect(port.ended.isEmpty)
  #expect(!transferLockIsFree(store))
  port.expire()
  // A runner that ignored the expiry would see the connection end instead of the cancellation.
  server.close()
  await #expect(throws: CancellationError.self) { try await run.value }
  #expect(port.ended == [1])
  #expect(transferLockIsFree(store))
  #expect(try await store.manifest() == nil)
}

@Test(.timeLimit(.minutes(1))) @MainActor
func expiryCancelsAnImportAndReleasesTheDatabase() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let server = try await Directory().serve()
  let store = try SnapshotStore(root: root)
  let engine = SyncEngine(api: try APIClient(origin: server.origin), store: store)
  let port = TestBackgroundTime()
  let gate = Gate()
  let (received, reached) = AsyncStream.makeStream(of: Void.self)
  let run = Task { @MainActor in
    try await BackgroundTimeRunner.run(port, name: "synchronize") {
      try await engine.synchronize { report in
        guard report.stage == SyncProgress.prepare, report.done > 0 else { return }
        reached.yield()
        await gate.wait()
      }
    }
  }
  for await _ in received { break }
  let header = try sampleHeader()
  // Another store on the same directory needs the exclusive transaction on writer.sqlite, which the import holds.
  let other = try SnapshotStore(root: root)
  await #expect(throws: (any Error).self) { try await other.begin(header: header) }
  port.expire()
  // A runner that ignored the expiry would let the opened gate finish the import.
  await gate.release()
  await #expect(throws: CancellationError.self) { try await run.value }
  #expect(port.ended == [1])
  #expect(try await store.manifest() == nil)
  try await other.begin(header: header)
  try await other.abort()
}

@Test @MainActor func aFinishedOperationEndsItsBackgroundTaskWithoutCancellation() async throws {
  let port = TestBackgroundTime()
  let value = try await BackgroundTimeRunner.run(port, name: "work") { 7 }
  #expect(value == 7)
  #expect(port.ended == [1])
  port.expire()
  #expect(port.ended == [1])
}
