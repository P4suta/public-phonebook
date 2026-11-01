import CryptoKit
import Foundation
import PhonebookCore
import Testing

@testable import PhonebookKit

private enum SyncFixture: CaseIterable, Sendable {
  case valid, wrongPrefecture, truncated, countMismatch, snapshotMismatch, headerMismatch,
    digestMismatch, cancellation
}

private func syncServer(_ mode: SyncFixture) async throws -> HTTPTestServer {
  let snapshot = try sampleSnapshot().rawValue
  let discovery = discoveryFixture(snapshot: snapshot)
  let lines = [ArchiveLine(name: "新しい施設")]
  let header = sampleHeaderObject(
    snapshot: mode == .headerMismatch ? "c" : "a",
    counts: [mode == .wrongPrefecture ? "14" : "13": 1])
  var compressed = try brotli(archiveText(header: header, lines: lines))
  if mode == .truncated { compressed.removeLast(4) }
  let archive = compressed
  let digest = SHA256.hash(data: archive).map { String(format: "%02x", $0) }.joined()
  let listed = mode == .digestMismatch ? String(repeating: "c", count: 64) : digest
  let contacts = mode == .countMismatch ? 2 : 1
  let file = "/api/v1/datasets/\(snapshot)/\(listed)/directory.tsv.br"
  let manifest = Data(
    """
    {"snapshot":"\(snapshot)","generatedAt":"2026-10-30","contacts":\(contacts),\
    "files":[{"file":"directory.tsv.br","sha256":"\(listed)","bytes":\(archive.count),\
    "url":"\(file)"}]}
    """.utf8)
  let identity = mode == .snapshotMismatch ? String(repeating: "b", count: 64) : snapshot
  return try await HTTPTestServer { request in
    let target = request.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
    if target == file {
      return Data(
        "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: application/octet-stream\r\nX-Dataset-Snapshot: \(identity)\r\nContent-Length: \(archive.count)\r\n\r\n"
          .utf8) + archive
    }
    let data = target.hasPrefix("/api/v1/datasets?") ? manifest : discovery
    return httpResponse(
      data,
      headers:
        "Content-Length: \(data.count)\r\nX-Dataset-Snapshot: \(snapshot)\r\nX-Directory-API-Version: 1\r\n"
    )
  }
}

@Test(.timeLimit(.minutes(1)), arguments: SyncFixture.allCases)
private func synchronizationPublishesOnlyCompleteValidatedArchives(_ mode: SyncFixture)
  async throws
{
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let trace = RecordingTrace()
  let store = try SnapshotStore(root: root, trace: trace)
  let original = try await publish([ArchiveLine(name: "前の施設")], to: store, snapshot: "d")
  trace.events.withLock { $0.removeAll() }
  let server = try await syncServer(mode)
  let engine = SyncEngine(
    api: try APIClient(origin: server.origin, trace: trace), store: store, trace: trace)
  let reported = ProgressLog()
  let operation = Task {
    try await engine.synchronize { value in
      await reported.append(value)
      if mode == .cancellation, value > 0 { withUnsafeCurrentTask { $0?.cancel() } }
    }
  }
  if mode == .valid {
    let result = try await operation.value
    #expect(result.origin == server.origin.absoluteString)
    #expect(result.previous == original.generation)
    #expect(
      try await store.contacts(generation: result.generation, ids: [1]).first?.name == "新しい施設")
    let values = await reported.values
    #expect(values.last == 1)
    #expect(values.allSatisfy { (0...1).contains($0) })
  } else {
    await #expect(throws: (any Error).self) { try await operation.value }
    #expect(try await store.manifest()?.generation == original.generation)
    #expect(
      try await store.contacts(generation: original.generation, ids: [1]).first?.name == "前の施設")
  }
  let records = trace.events.withLock { $0 }
  #expect(!records.isEmpty)
  #expect(Set(records.map(\.operation)).count == 1)
}

private actor ProgressLog {
  var values: [Double] = []
  func append(_ value: Double) { values.append(value) }
}

private enum CleanupFault: Error { case refused }
private struct FailedRemoval: SnapshotFiles {
  func readManifest(at url: URL) throws -> Data { try LocalSnapshotFiles().readManifest(at: url) }
  func activateManifest(_ data: Data, at url: URL) throws {
    try LocalSnapshotFiles().activateManifest(data, at: url)
  }
  func removeGeneration(at url: URL) throws { throw CleanupFault.refused }
}

@Test(.timeLimit(.minutes(1))) func synchronizationPreservesPrimaryAndCleanupFailures() async throws
{
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let store = try SnapshotStore(root: root, files: FailedRemoval())
  let server = try await syncServer(.wrongPrefecture)
  let engine = SyncEngine(api: try APIClient(origin: server.origin), store: store)
  do {
    _ = try await engine.synchronize(progress: { _ in })
    Issue.record("An inconsistent archive succeeded")
  } catch let failure as SyncFailure {
    #expect(failure.primary as? ImportError == .unexpectedCount)
    #expect(failure.cleanup is CleanupFault)
  }
  #expect(try await store.manifest() == nil)
}
