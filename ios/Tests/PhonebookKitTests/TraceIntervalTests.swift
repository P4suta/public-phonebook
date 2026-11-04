import Foundation
import PhonebookCore
import Synchronization
import Testing

@testable import PhonebookKit

/// Serves a listing of a three-batch archive, and with `cut` sends that many archive bytes and keeps the connection open.
private func server(rows: Int, archiveStatus: String = "200 OK", cut: Int? = nil) async throws
  -> (HTTPTestServer, Int)
{
  let snapshot = try sampleSnapshot().rawValue
  let lines = (0..<rows).map { ArchiveLine(name: "図書館\($0) \(UInt64($0) &* 0x9E37_79B9)") }
  let archive = try brotli(
    archiveText(header: sampleHeaderObject(counts: ["13": rows]), lines: lines))
  let digest = sha256Hex(archive)
  let file = "/api/datasets/\(snapshot)/\(digest)/directory.tsv.br"
  let listing = datasetsFixture(
    snapshot: snapshot, contacts: rows, sha256: digest, bytes: archive.count, url: file)
  let server = try await HTTPTestServer(finish: cut == nil) { request in
    let target = request.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
    if target == "/api/datasets" {
      return httpResponse(
        listing, headers: "Content-Length: \(listing.count)\r\nX-Dataset-Snapshot: \(snapshot)\r\n")
    }
    guard target == file, archiveStatus == "200 OK" else { return notFoundResponse }
    return Data(
      "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: application/octet-stream\r\nX-Dataset-Snapshot: \(snapshot)\r\nContent-Length: \(archive.count)\r\n\r\n"
        .utf8) + archive.prefix(cut ?? archive.count)
  }
  return (server, archive.count)
}

/// Pairs a recorded trace, and returns how many intervals began, how many ended, and how many stayed open.
private func pair(_ events: [TraceEvent]) -> (began: Int, ended: Int, open: Int) {
  var intervals = TraceIntervals<Int>()
  var began = 0
  var ended: [Int] = []
  for event in events {
    intervals.record(
      event,
      begin: { _ in
        began += 1
        return began
      }, end: { _, state in ended.append(state) }, mark: { _ in })
  }
  #expect(Set(ended).count == ended.count)
  return (began, ended.count, intervals.openCount)
}

@Test(.timeLimit(.minutes(1)))
func everySynchronizationIntervalEndsOnceAfterSuccessFailureAndCancellation()
  async throws
{
  let succeeded = RecordingTrace()
  do {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let (origin, _) = try await server(rows: 3_000)
    let store = try SnapshotStore(root: root, trace: succeeded)
    _ = try await SyncEngine(
      api: try APIClient(origin: origin.origin, trace: succeeded), store: store, trace: succeeded
    ).synchronize { _ in }
  }
  let failed = RecordingTrace()
  do {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let (origin, _) = try await server(rows: 3_000, archiveStatus: "404 Not Found")
    let store = try SnapshotStore(root: root, trace: failed)
    await #expect(throws: (any Error).self) {
      _ = try await SyncEngine(
        api: try APIClient(origin: origin.origin, trace: failed), store: store, trace: failed
      ).synchronize { _ in }
    }
  }
  let cancelled = RecordingTrace()
  do {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let (origin, bytes) = try await server(rows: 3_000, cut: 1_000)
    let store = try SnapshotStore(root: root, trace: cancelled)
    let engine = SyncEngine(
      api: try APIClient(origin: origin.origin, trace: cancelled), store: store, trace: cancelled)
    let (received, reached) = AsyncStream.makeStream(of: Void.self)
    let run = Task {
      try await engine.synchronize { report in
        if report.stage == SyncProgress.transfer, report.done >= 1_000 { reached.yield() }
      }
    }
    for await _ in received { break }
    run.cancel()
    origin.close()
    await #expect(throws: CancellationError.self) { try await run.value }
    #expect(bytes > 1_000)
  }
  for (name, trace) in [("succeeded", succeeded), ("failed", failed), ("cancelled", cancelled)] {
    let events = trace.events.withLock { $0 }
    let result = pair(events)
    #expect(result.began > 0, "\(name)")
    #expect(result.began == result.ended, "\(name)")
    #expect(result.open == 0, "\(name)")
  }
}

@Test func aRepeatedStartEndsTheEarlierIntervalAndADecodeEndsTheStaging() throws {
  let operation = UUID()
  let snapshot = try sampleSnapshot()
  let events = [
    TraceEvent(operation: operation, phase: .stage, outcome: .started, snapshot: snapshot),
    TraceEvent(operation: operation, phase: .download, outcome: .started),
    TraceEvent(operation: operation, phase: .download, outcome: .started),
    TraceEvent(operation: operation, phase: .download, outcome: .completed),
    TraceEvent(operation: operation, phase: .insert, outcome: .completed, milliseconds: 4),
    TraceEvent(operation: operation, phase: .decode, outcome: .completed, snapshot: snapshot),
  ]
  var intervals = TraceIntervals<Int>()
  var log: [String] = []
  for (index, event) in events.enumerated() {
    intervals.record(
      event,
      begin: { key in
        log.append("begin \(key.phase.rawValue)")
        return index
      }, end: { key, _ in log.append("end \(key.phase.rawValue)") },
      mark: { log.append("mark \($0.phase.rawValue)") })
  }
  #expect(
    log == [
      "begin stage", "begin download", "end download", "begin download", "end download",
      "mark insert", "mark decode", "end stage",
    ])
  #expect(intervals.openCount == 0)
}
