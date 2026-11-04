import Foundation
import PhonebookCore
import Synchronization
import Testing

@testable import PhonebookKit

/// A body long enough to arrive in more than one piece, with bytes that differ by position.
private let body = Data((0..<200_000).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ $0 >> 9) })

private func archive(digest: String = sha256Hex(body), bytes: Int = body.count) throws
  -> DatasetArchive
{
  try sampleArchive(bytes: bytes, digest: digest)
}

private func requestedRange(_ request: String) -> Int? {
  request.components(separatedBy: "\r\n").first { $0.lowercased().hasPrefix("range: bytes=") }
    .flatMap { Int($0.dropFirst("range: bytes=".count).dropLast()) }
}

private func head(_ status: String, length: Int, extra: String = "") throws -> Data {
  let snapshot = try sampleSnapshot().rawValue
  return Data(
    "HTTP/1.1 \(status)\r\nConnection: close\r\nContent-Type: application/octet-stream\r\nX-Dataset-Snapshot: \(snapshot)\r\nAccept-Ranges: bytes\r\nContent-Length: \(length)\r\n\(extra)\r\n"
      .utf8)
}

/// Answers a Range request with 206 from the requested byte, and a plain request with 200 that stops after `cut` bytes.
/// Every connection stays open until the test calls `close()`.
private func resumingServer(cut: Int, ranges: RequestLog) async throws -> HTTPTestServer {
  try await HTTPTestServer(finish: false) { request in
    if let first = requestedRange(request) {
      ranges.record("\(first)")
      return
        (try? head(
          "206 Partial Content", length: body.count - first,
          extra: "Content-Range: bytes \(first)-\(body.count - 1)/\(body.count)\r\n"))
        .map { $0 + body[first...] } ?? Data()
    }
    ranges.record("whole")
    return (try? head("200 OK", length: body.count)).map { $0 + body.prefix(cut) } ?? Data()
  }
}

@Test(.timeLimit(.minutes(1))) func anInterruptedDownloadResumesWithARangeRequest() async throws {
  let partials = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: partials) }
  let ranges = RequestLog()
  let cut = 80_000
  let server = try await resumingServer(cut: cut, ranges: ranges)
  let api = try APIClient(origin: server.origin)
  await #expect(throws: (any Error).self) {
    _ = try await api.download(archive(), partials: partials) { report in
      if report.resumed + report.received >= cut { server.close() }
    }
  }
  let partial = partials.appendingPathComponent(
    "\(try sampleSnapshot().rawValue)-\(sha256Hex(body)).partial")
  let kept = try Data(contentsOf: partial)
  #expect(kept == body.prefix(cut))
  let reports = Mutex<[TransferProgress]>([])
  let file = try await api.download(archive(), partials: partials) { report in
    reports.withLock { $0.append(report) }
  }
  #expect(file == partial)
  #expect(try Data(contentsOf: file) == body)
  #expect(ranges.ordered == ["whole", "\(cut)"])
  let last = try #require(reports.withLock { $0.last })
  #expect(last == TransferProgress(resumed: cut, received: body.count - cut, total: body.count))
}

@Test(.timeLimit(.minutes(1))) func aServerThatIgnoresTheRangeRestartsTheFile() async throws {
  let partials = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: partials) }
  let partial = partials.appendingPathComponent(
    "\(try sampleSnapshot().rawValue)-\(sha256Hex(body)).partial")
  try Data(repeating: 0xFF, count: 5_000).write(to: partial)
  let ranges = RequestLog()
  let server = try await HTTPTestServer { request in
    ranges.record(requestedRange(request).map(String.init) ?? "whole")
    return (try? head("200 OK", length: body.count)).map { $0 + body } ?? Data()
  }
  let file = try await APIClient(origin: server.origin).download(archive(), partials: partials)
  #expect(try Data(contentsOf: file) == body)
  #expect(ranges.ordered == ["5000"])
}

@Test(.timeLimit(.minutes(1))) func aChangedSnapshotOrDigestDiscardsTheKeptBytes() async throws {
  let partials = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: partials) }
  let stale = partials.appendingPathComponent(
    "\(try sampleSnapshot().rawValue)-\(String(repeating: "c", count: 64)).partial")
  try Data(body.prefix(1_000)).write(to: stale)
  let ranges = RequestLog()
  let server = try await resumingServer(cut: body.count, ranges: ranges)
  let file = try await APIClient(origin: server.origin).download(archive(), partials: partials)
  #expect(try Data(contentsOf: file) == body)
  #expect(!FileManager.default.fileExists(atPath: stale.path))
  #expect(ranges.ordered == ["whole"])
}

@Test(.timeLimit(.minutes(1))) func aCompleteVerifiedFileSkipsTheRequest() async throws {
  let partials = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: partials) }
  let partial = partials.appendingPathComponent(
    "\(try sampleSnapshot().rawValue)-\(sha256Hex(body)).partial")
  try body.write(to: partial)
  let ranges = RequestLog()
  let server = try await resumingServer(cut: body.count, ranges: ranges)
  let file = try await APIClient(origin: server.origin).download(archive(), partials: partials)
  #expect(file == partial)
  #expect(server.requestCount == 0)
  try Data(repeating: 1, count: body.count).write(to: partial)
  _ = try await APIClient(origin: server.origin).download(archive(), partials: partials)
  #expect(ranges.ordered == ["whole"])
}

@Test(.timeLimit(.minutes(1))) func aWrongContentRangeOrAnUnsatisfiableRangeKeepsNoBadBytes()
  async throws
{
  let partials = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: partials) }
  let partial = partials.appendingPathComponent(
    "\(try sampleSnapshot().rawValue)-\(sha256Hex(body)).partial")
  try Data(body.prefix(1_000)).write(to: partial)
  let shifted = try await HTTPTestServer { _ in
    (try? head(
      "206 Partial Content", length: body.count - 999,
      extra: "Content-Range: bytes 999-\(body.count - 1)/\(body.count)\r\n"))
      .map { $0 + body[999...] } ?? Data()
  }
  await #expect(throws: ServiceError.invalidResponse) {
    _ = try await APIClient(origin: shifted.origin).download(archive(), partials: partials)
  }
  #expect(try Data(contentsOf: partial) == body.prefix(1_000))
  let unsatisfiable = try await HTTPTestServer { _ in
    Data(
      "HTTP/1.1 416 Range Not Satisfiable\r\nConnection: close\r\nContent-Range: bytes */\(body.count)\r\nContent-Length: 0\r\n\r\n"
        .utf8)
  }
  await #expect(throws: ServiceError.http(416)) {
    _ = try await APIClient(origin: unsatisfiable.origin).download(archive(), partials: partials)
  }
  #expect(try Data(contentsOf: partial).isEmpty)
}

@Test func contentRangeAcceptsOnlyOneCompleteRange() {
  #expect(ContentRange("bytes 5-9/10") == ContentRange("bytes 5-9/10"))
  #expect(ContentRange("bytes 5-9/10")?.first == 5)
  for invalid in [
    "bytes */10", "bytes 9-5/10", "bytes 5-10/10", "bytes 5-9/*", "items 5-9/10", "bytes -5-9/10",
    "bytes 5-9/10/11", "bytes 5 -9/10", "bytes ５-9/10",
    "bytes 1234567890123456789-1234567890123456790/1234567890123456791",
  ] {
    #expect(ContentRange(invalid) == nil, "\(invalid)")
  }
}

/// A synchronization cut during the transfer keeps the received bytes, and the next one resumes them and removes them once saved.
@Test(.timeLimit(.minutes(1))) func synchronizationResumesTheBytesOfAFailedAttempt() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let rows = 3_000
  let snapshot = try sampleSnapshot().rawValue
  let lines = (0..<rows).map { ArchiveLine(name: "施設\($0) \(UInt64($0) &* 0x9E37_79B9)") }
  let archive = try brotli(
    archiveText(header: sampleHeaderObject(counts: ["13": rows]), lines: lines))
  let digest = sha256Hex(archive)
  let file = "/api/datasets/\(snapshot)/\(digest)/directory.tsv.br"
  let listing = datasetsFixture(
    snapshot: snapshot, contacts: rows, sha256: digest, bytes: archive.count, url: file)
  let ranges = RequestLog()
  let cut = archive.count / 2
  let server = try await HTTPTestServer(finish: false) { request in
    let target = request.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
    if target == "/api/datasets" {
      return httpResponse(
        listing,
        headers: "Content-Length: \(listing.count)\r\nX-Dataset-Snapshot: \(snapshot)\r\n")
    }
    guard target == file else { return notFoundResponse }
    if let first = requestedRange(request) {
      ranges.record("\(first)")
      return
        (try? head(
          "206 Partial Content", length: archive.count - first,
          extra: "Content-Range: bytes \(first)-\(archive.count - 1)/\(archive.count)\r\n"))
        .map { $0 + archive[first...] } ?? Data()
    }
    ranges.record("whole")
    return (try? head("200 OK", length: archive.count)).map { $0 + archive.prefix(cut) } ?? Data()
  }
  let store = try SnapshotStore(root: root)
  let engine = SyncEngine(api: try APIClient(origin: server.origin), store: store)
  await #expect(throws: (any Error).self) {
    _ = try await engine.synchronize { report in
      if report.stage == SyncProgress.transfer, report.done >= cut { server.close() }
    }
  }
  #expect(try await store.manifest() == nil)
  let kept = try FileManager.default.contentsOfDirectory(atPath: store.transfers.path)
    .filter { $0.hasSuffix(".partial") }
  #expect(kept.count == 1)
  let keptBytes = try kept.first.map {
    try Data(contentsOf: store.transfers.appendingPathComponent($0)).count
  }
  #expect(keptBytes == cut)
  let reported = Mutex<[SyncProgress]>([])
  let manifest = try await engine.synchronize { report in reported.withLock { $0.append(report) } }
  #expect(manifest.records == rows)
  #expect(ranges.ordered == ["whole", "\(cut)"])
  #expect(
    try FileManager.default.contentsOfDirectory(atPath: store.transfers.path)
      .filter { $0.hasSuffix(".partial") }.isEmpty)
  let transfers = reported.withLock {
    $0.filter { $0.stage == SyncProgress.transfer && $0.total > 0 }
  }
  // The resumed attempt counts only its own bytes as done, while the bar starts from the kept bytes.
  #expect(transfers.allSatisfy { $0.total < archive.count })
  #expect(transfers.allSatisfy { $0.fraction > 0 })
  let stages = reported.withLock { $0.map(\.stage) }
  #expect(stages.contains(SyncProgress.prepare) && stages.last == SyncProgress.identify)
}

@Test func updatesRefuseExpensiveAndConstrainedPaths() throws {
  var request = URLRequest(url: try #require(URL(string: "https://www.dial.page/api/datasets")))
  NetworkPaths.inexpensive.apply(to: &request)
  #expect(!request.allowsExpensiveNetworkAccess && !request.allowsConstrainedNetworkAccess)
  NetworkPaths.every.apply(to: &request)
  #expect(request.allowsExpensiveNetworkAccess && request.allowsConstrainedNetworkAccess)
}
