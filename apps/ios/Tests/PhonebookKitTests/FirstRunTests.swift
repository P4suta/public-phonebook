import Foundation
import PhonebookCore
import Synchronization
import Testing

@testable import PhonebookKit

/// The provider's updated revision as a first run from the baseline bundle meets it, with one fault at most.
private enum FirstRunMode: CaseIterable {
  case delta, namesBundled, noDelta, unreachable, wrongBaseDigest, wrongDeltaDigest, cutTransfer
  case unrelatedBase, unrelatedTarget, unrelatedArchive
}

private func head(_ entry: CorpusEntry, length: Int) -> Data {
  let headers = entry.headers.map { "\($0.key): \($0.value)\r\n" }.joined()
  return Data(
    "HTTP/1.1 \(entry.status) OK\r\nConnection: close\r\n\(headers)Content-Length: \(length)\r\n\r\n"
      .utf8)
}

private func replacing(_ entry: CorpusEntry, path: String? = nil, body: Data) -> CorpusEntry {
  CorpusEntry(
    revision: entry.revision, path: path ?? entry.path, status: entry.status,
    headers: entry.headers,
    body: entry.encoding == "base64"
      ? body.base64EncodedString() : String(decoding: body, as: UTF8.self),
    encoding: entry.encoding)
}

/// Rewrites the delta header's decoded base digest and lists the re-encoded delta under its own digest.
private func wrongBaseDigest(_ entries: [CorpusEntry], in root: URL) async throws -> [CorpusEntry] {
  let listingEntry = try #require(entries.first { $0.path.hasPrefix("/api/dataset-deltas?") })
  var listing = try #require(
    try JSONSerialization.jsonObject(with: listingEntry.data) as? [String: Any])
  var deltas = try #require(listing["deltas"] as? [[String: Any]])
  let oldURL = try #require(deltas[0]["url"] as? String)
  let deltaEntry = try #require(entries.first { $0.path == oldURL })
  var lines = try await decodedBrotli(deltaEntry.data, in: root).split(
    separator: 0x0A, omittingEmptySubsequences: false)
  var header = try #require(try JSONSerialization.jsonObject(with: lines[1]) as? [String: Any])
  var base = try #require(header["base"] as? [String: Any])
  base["sha256"] = String(repeating: "0", count: 64)
  header["base"] = base
  lines[1] = try JSONSerialization.data(withJSONObject: header, options: [.sortedKeys])[...]
  let text = Data(lines.joined(separator: [0x0A]))
  let encoded = try brotli(text)
  let digest = sha256Hex(encoded)
  let snapshot = try #require(listing["snapshot"] as? String)
  let file = try #require(deltas[0]["file"] as? String)
  let url = "/api/datasets/\(snapshot)/\(digest)/\(file)"
  deltas[0]["sha256"] = digest
  deltas[0]["bytes"] = encoded.count
  deltas[0]["uncompressedBytes"] = text.count
  deltas[0]["url"] = url
  listing["deltas"] = deltas
  return entries.map { entry in
    if entry.path == listingEntry.path {
      return (try? JSONSerialization.data(withJSONObject: listing)).map {
        replacing(entry, body: $0)
      } ?? entry
    }
    return entry.path == oldURL ? replacing(entry, path: url, body: encoded) : entry
  }
}

private func withoutDeltas(_ entries: [CorpusEntry]) throws -> [CorpusEntry] {
  try entries.map { entry in
    guard entry.path == "/api/datasets" else { return entry }
    var listing = try #require(try JSONSerialization.jsonObject(with: entry.data) as? [String: Any])
    listing["datasetDeltas"] = nil
    return replacing(entry, body: try JSONSerialization.data(withJSONObject: listing))
  }
}

private func unrelatedDelta(_ mode: FirstRunMode, entries: [CorpusEntry]) throws -> [CorpusEntry] {
  try entries.map { entry in
    guard entry.path.hasPrefix("/api/dataset-deltas?") else { return entry }
    var object = try #require(try JSONSerialization.jsonObject(with: entry.data) as? [String: Any])
    var deltas = try #require(object["deltas"] as? [[String: Any]])
    let foreign = String(repeating: "e", count: 64)
    if mode == .unrelatedTarget { object["snapshot"] = foreign }
    if mode == .unrelatedArchive { object["archiveSha256"] = foreign }
    let snapshot = try #require(object["snapshot"] as? String)
    for index in deltas.indices {
      if mode == .unrelatedBase {
        deltas[index]["base"] = foreign
        deltas[index]["file"] = "directory-delta-\(foreign).tsv.br"
      }
      let digest = try #require(deltas[index]["sha256"] as? String)
      let file = try #require(deltas[index]["file"] as? String)
      deltas[index]["url"] = "/api/datasets/\(snapshot)/\(digest)/\(file)"
    }
    object["deltas"] = deltas
    let changed = replacing(entry, body: try JSONSerialization.data(withJSONObject: object))
    var headers = changed.headers
    if let key = headers.keys.first(where: { $0.lowercased() == "x-dataset-snapshot" }) {
      headers[key] = snapshot
    }
    return CorpusEntry(
      revision: changed.revision, path: changed.path, status: changed.status, headers: headers,
      body: changed.body, encoding: changed.encoding)
  }
}

private func entries(_ mode: FirstRunMode, in root: URL) async throws -> [CorpusEntry] {
  let updated = try corpus("updated")
  switch mode {
  case .delta, .cutTransfer: return updated
  case .namesBundled: return try corpus("baseline")
  case .noDelta: return try withoutDeltas(updated)
  case .unrelatedBase, .unrelatedTarget, .unrelatedArchive:
    return try unrelatedDelta(mode, entries: updated)
  case .unreachable: return []
  case .wrongBaseDigest: return try await wrongBaseDigest(updated, in: root)
  case .wrongDeltaDigest:
    return try updated.map { entry in
      guard entry.path.contains("/directory-delta-") else { return entry }
      var body = try entry.data
      body[body.count / 2] ^= 0x01
      return replacing(entry, body: body)
    }
  }
}

/// Serves the entries, and cuts the delta reply in half for `cutTransfer`.
private func server(_ mode: FirstRunMode, entries: [CorpusEntry], requests: RequestLog)
  async throws -> HTTPTestServer
{
  let responses = try Dictionary(
    uniqueKeysWithValues: entries.map { entry in
      let body = try entry.data
      let cut = mode == .cutTransfer && entry.path.contains("/directory-delta-")
      return (
        entry.path, head(entry, length: body.count) + (cut ? body.prefix(body.count / 2) : body)
      )
    })
  return try await HTTPTestServer { request in
    let target = request.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
    requests.record(target)
    return responses[target] ?? notFoundResponse
  }
}

private func run(_ mode: FirstRunMode, createScratch: Bool = true) async throws -> (
  result: FirstRunResult, plan: FirstRunPlan, store: SnapshotStore, root: URL, scratch: URL,
  requests: Set<String>, updated: [CorpusEntry]
) {
  let root = try temporaryDirectory()
  let fixture = try bundledFixture(in: root)
  let bundle = try await BundledDataset.open(
    archive: fixture.archive, entry: writeEntry(fixture.entry, in: root))
  let requests = RequestLog()
  let served = try await entries(mode, in: root)
  let server = try await server(mode, entries: served, requests: requests)
  let store = try SnapshotStore(root: root.appendingPathComponent("store"))
  let scratch = root.appendingPathComponent("scratch")
  if createScratch {
    try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
  }
  let trace = RecordingTrace()
  let engine = SyncEngine(
    api: try APIClient(origin: server.origin), store: store, trace: trace,
    temporaryDirectory: scratch)
  let plan = try await engine.planFirstRun(bundle: bundle)
  let result = try await engine.firstRun(bundle: bundle, progress: { _ in })
  let events = trace.events.withLock { $0.filter { [.discovery, .delta].contains($0.phase) } }
  var expected = ["discovery.started", "discovery.completed"]
  switch mode {
  case .unreachable, .unrelatedTarget: expected[1] = "discovery.deferred"
  case .delta: expected += ["delta.started", "delta.completed"]
  case .wrongBaseDigest, .wrongDeltaDigest, .cutTransfer:
    expected += ["delta.started", "delta.rejected"]
  default: break
  }
  #expect(events.map { $0.phase.rawValue + "." + $0.outcome.rawValue } == expected)
  return (result, plan, store, root, scratch, requests.received, try corpus("updated"))
}

@Test(.timeLimit(.minutes(1))) func providerDeltaRebuildsTheUpdatedArchiveFromTheBundle()
  async throws
{
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let fixture = try bundledFixture(in: root)
  let updated = try corpus("updated")
  let listingEntry = try #require(updated.first { $0.path.hasPrefix("/api/dataset-deltas?") })
  let listing = try JSONDecoder().decode(DirectoryDeltaListing.self, from: listingEntry.data)
  let delta = try #require(listing.deltas.compactMap(\.entry).first)
  let deltaFile = root.appendingPathComponent("delta.br")
  try #require(updated.first { $0.path == delta.url }).data.write(to: deltaFile)
  let decoded = try await DecodedArchive.decode(
    fixture.archive, into: root.appendingPathComponent("base"))
  #expect(
    decoded.identity.bytes
      == Data(try await decodedBrotli(Data(contentsOf: fixture.archive), in: root)).count)
  let rebuilt = root.appendingPathComponent("rebuilt")
  let admission = try await DirectoryDeltaApplier(
    url: deltaFile, decodedBytes: delta.uncompressedBytes, target: listing.snapshot,
    targetArchive: listing.archiveSha256
  ).rebuild(from: decoded.base, into: rebuilt)
  #expect(admission == .apply)
  let archive = try #require(updated.first { $0.path.hasSuffix("/directory.tsv.br") })
  #expect(try Data(contentsOf: rebuilt) == (try await decodedBrotli(archive.data, in: root)))
}

@Test(.timeLimit(.minutes(1))) func firstRunAppliesTheListedDeltaToTheBundleOnce() async throws {
  let run = try await run(.delta)
  defer { try? FileManager.default.removeItem(at: run.root) }
  let listing = try #require(run.updated.first { $0.path == "/api/datasets" })
  let datasets = try JSONDecoder().decode(DirectoryDatasets.self, from: listing.data)
  #expect(run.plan.transfer == .delta)
  #expect(run.result.outcome == .listed)
  #expect(run.result.manifest.snapshot == datasets.snapshot)
  #expect(run.result.manifest.previous == nil)
  #expect(try await run.store.manifest()?.generation == run.result.manifest.generation)
  #expect(run.requests.contains { $0.contains("/directory-delta-") })
  #expect(!run.requests.contains { $0.hasSuffix("/directory.tsv.br") })
  #expect(try FileManager.default.contentsOfDirectory(atPath: run.scratch.path).isEmpty)
}

@Test func firstRunCreatesMissingScratchParents() async throws {
  let result = try await run(.delta, createScratch: false)
  defer { try? FileManager.default.removeItem(at: result.root) }
  #expect(result.plan.transfer == .delta && result.result.outcome == .listed)
  #expect(try FileManager.default.contentsOfDirectory(atPath: result.scratch.path).isEmpty)
}

@Test(.timeLimit(.minutes(1))) func firstRunStagesACurrentBundleWithoutATransfer() async throws {
  let run = try await run(.namesBundled)
  defer { try? FileManager.default.removeItem(at: run.root) }
  #expect(run.plan == FirstRunPlan(transfer: .none, notice: .noTransfer, fallsBackToBundle: true))
  #expect(run.result.outcome == .listed)
  #expect(run.requests == ["/api/datasets"])
}

@Test(.timeLimit(.minutes(1))) func firstRunDownloadsTheArchiveWhenNoDeltaStartsFromTheBundle()
  async throws
{
  let run = try await run(.noDelta)
  defer { try? FileManager.default.removeItem(at: run.root) }
  #expect(run.plan.transfer == .archive)
  #expect(run.result.outcome == .listed)
  #expect(run.requests.contains { $0.hasSuffix("/directory.tsv.br") })
  #expect(try FileManager.default.contentsOfDirectory(atPath: run.scratch.path).isEmpty)
}

@Test(arguments: [FirstRunMode.unrelatedBase, .unrelatedTarget, .unrelatedArchive])
private func firstRunIgnoresDeltasOutsideTheBundledArchiveIdentity(_ mode: FirstRunMode)
  async throws
{
  let result = try await run(mode)
  defer { try? FileManager.default.removeItem(at: result.root) }
  #expect(result.plan.transfer == (mode == .unrelatedTarget ? .none : .archive))
  #expect(result.result.outcome == (mode == .unrelatedTarget ? .bundled : .listed))
  #expect(
    result.requests.contains { $0.hasSuffix("/directory.tsv.br") } == (mode != .unrelatedTarget))
  #expect(!result.requests.contains { $0.contains("/directory-delta-") })
}

/// Every failure after a readable bundle saves the bundled snapshot alone and leaves no temporary file.
@Test(
  .timeLimit(.minutes(1)),
  arguments: [
    FirstRunMode.unreachable, .wrongBaseDigest, .wrongDeltaDigest, .cutTransfer,
  ])
private func failedFirstRunsSaveTheBundledSnapshot(_ mode: FirstRunMode) async throws {
  let run = try await run(mode)
  defer { try? FileManager.default.removeItem(at: run.root) }
  let baseline = try JSONDecoder().decode(
    DirectoryDatasets.self,
    from: try #require(try corpus("baseline").first { $0.path == "/api/datasets" }).data)
  #expect(run.plan.transfer == (mode == .unreachable ? .none : .delta))
  #expect(run.result.outcome == .bundled)
  #expect(run.result.manifest.snapshot == baseline.snapshot)
  #expect(try await run.store.manifest()?.snapshot == baseline.snapshot)
  #expect(try FileManager.default.contentsOfDirectory(atPath: run.scratch.path).isEmpty)
}

private enum EngineEntry: CaseIterable, Sendable {
  case bundled, discovered, listed
}

private func synchronize(
  _ entry: EngineEntry, engine: SyncEngine, bundle: BundledDataset, listing: DatasetListing,
  progress: @escaping @Sendable (SyncProgress) async -> Void
) async throws -> SnapshotManifest {
  switch entry {
  case .bundled: try await engine.firstRun(bundle: bundle, progress: progress).manifest
  case .discovered: try await engine.synchronize(progress: progress)
  case .listed: try await engine.synchronize(listing: listing, paths: .every, progress: progress)
  }
}

@Test(arguments: EngineEntry.allCases)
private func synchronizationRejectsOverlapAndReleasesItsGuard(_ entry: EngineEntry) async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let fixture = try bundledFixture(in: root)
  let bundle = try await BundledDataset.open(
    archive: fixture.archive, entry: writeEntry(fixture.entry, in: root))
  let origin = try await server(
    .namesBundled, entries: try corpus("baseline"), requests: RequestLog())
  let api = try APIClient(origin: origin.origin)
  let listing = try await api.datasets()
  let engine = SyncEngine(
    api: api, store: try SnapshotStore(root: root.appendingPathComponent("store")))
  let (events, signal) = AsyncStream.makeStream(of: Bool.self)
  let (release, resume) = AsyncStream.makeStream(of: Void.self)
  let entered = Mutex(false)
  defer {
    resume.yield()
    resume.finish()
    signal.finish()
  }
  let active = Task {
    do {
      let result = try await synchronize(entry, engine: engine, bundle: bundle, listing: listing) {
        _ in
        let first = entered.withLock { value in
          if value { return false }
          value = true
          return true
        }
        if first {
          signal.yield(true)
          for await _ in release { break }
        }
      }
      signal.yield(false)
      return result
    } catch {
      signal.yield(false)
      throw error
    }
  }
  var iterator = events.makeAsyncIterator()
  try #require(await iterator.next() == true)
  await #expect(throws: ImportError.alreadyUpdating) {
    try await synchronize(
      entry, engine: engine, bundle: bundle, listing: listing, progress: { _ in })
  }
  resume.yield()
  let first = try await active.value
  let second = try await synchronize(
    entry, engine: engine, bundle: bundle, listing: listing, progress: { _ in })
  #expect(first.snapshot == second.snapshot && first.generation != second.generation)
}

private struct FailedPlanningTransport: HTTPTransport {
  enum Failure: CaseIterable, Sendable { case unavailable, cancelled, cancelledTask }
  let failure: Failure
  func send(_ request: URLRequest) async throws -> HTTPResult {
    switch failure {
    case .unavailable: throw URLError(.notConnectedToInternet)
    case .cancelled: throw CancellationError()
    case .cancelledTask:
      withUnsafeCurrentTask { $0?.cancel() }
      throw URLError(.networkConnectionLost)
    }
  }
}

@Test(arguments: FailedPlanningTransport.Failure.allCases)
private func planningWithoutABundleDistinguishesOfflineAndCancellation(
  _ failure: FailedPlanningTransport.Failure
) async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let api = try APIClient(
    origin: try #require(URL(string: "https://dial.page")),
    transport: FailedPlanningTransport(failure: failure))
  let engine = SyncEngine(api: api, store: try SnapshotStore(root: root))
  let operation = Task { try await engine.planFirstRun(bundle: nil) }
  if failure == .unavailable {
    let plan = try await operation.value
    #expect(plan == FirstRunPlan.decide(bundle: .missing, listing: .unreachable))
  } else {
    await #expect(throws: CancellationError.self) { try await operation.value }
  }
}

@Test(.timeLimit(.minutes(1))) func firstRunWithoutABundleDownloadsTheArchive() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let requests = RequestLog()
  let server = try await server(.delta, entries: try corpus("updated"), requests: requests)
  let engine = SyncEngine(
    api: try APIClient(origin: server.origin),
    store: try SnapshotStore(root: root.appendingPathComponent("store")))
  let plan = try await engine.planFirstRun(bundle: nil)
  #expect(plan.transfer == .archive)
  let result = try await engine.firstRun(bundle: nil, progress: { _ in })
  #expect(result.outcome == .listed)
  #expect(requests.received.contains { $0.hasSuffix("/directory.tsv.br") })
  #expect(!requests.received.contains { $0.contains("/directory-delta-") })
}

@Test(.timeLimit(.minutes(1))) func cancelledFirstRunLeavesNoTemporaryFileAndNoSnapshot()
  async throws
{
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let fixture = try bundledFixture(in: root)
  let bundle = try await BundledDataset.open(
    archive: fixture.archive, entry: writeEntry(fixture.entry, in: root))
  let updated = try corpus("updated")
  let responses = try Dictionary(
    uniqueKeysWithValues: updated.map { entry in
      let body = try entry.data
      // The delta reply sends its head and holds its body, so the run waits inside the transfer.
      let held = entry.path.contains("/directory-delta-")
      return (entry.path, head(entry, length: body.count) + (held ? Data() : body))
    })
  let (held, signal) = AsyncStream.makeStream(of: Void.self)
  let server = try await HTTPTestServer(finish: false) { request in
    let target = request.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
    if target.contains("/directory-delta-") { signal.yield() }
    return responses[target] ?? notFoundResponse
  }
  defer { server.close() }
  let store = try SnapshotStore(root: root.appendingPathComponent("store"))
  let scratch = root.appendingPathComponent("scratch")
  try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
  let trace = RecordingTrace()
  let engine = SyncEngine(
    api: try APIClient(origin: server.origin), store: store, trace: trace,
    temporaryDirectory: scratch)
  let task = Task { try await engine.firstRun(bundle: bundle, progress: { _ in }) }
  for await _ in held { break }
  task.cancel()
  await #expect(throws: CancellationError.self) { _ = try await task.value }
  #expect(
    trace.events.withLock {
      $0.filter { $0.phase == .delta }.map(\.outcome)
    } == [.started, .cancelled])
  #expect(try await store.manifest() == nil)
  #expect(try FileManager.default.contentsOfDirectory(atPath: scratch.path).isEmpty)
}
