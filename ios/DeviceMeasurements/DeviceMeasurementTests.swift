import Foundation
import Network
import PhonebookKit
import Synchronization
import XCTest

/// Measures the first run's three paths in the host app on a physical iPhone.
/// XCTest records metric values, and each test attaches phase timings and a separate space trial.
final class DeviceMeasurementTests: XCTestCase {
  /// The discard port refuses the listing at once, so the first run saves the bundled snapshot alone.
  private static let refused = URL(string: "http://127.0.0.1:9")

  func testBundledImport() throws {
    let origin = try XCTUnwrap(Self.refused)
    let entryURL = try XCTUnwrap(Bundle.main.url(forResource: "directory", withExtension: "json"))
    let entry = try JSONDecoder().decode(BundledEntry.self, from: Data(contentsOf: entryURL))
    try measurePath(
      "bundledImport", snapshot: entry.snapshot.rawValue, imports: 1, deltas: 0
    ) {
      root, observation in
      try await Self.firstRun(origin: origin, root: root, observation: observation)
    }
  }

  func testDeltaFromTheBundle() throws {
    let server = try ReplayServer.start()
    try measurePath("deltaFromTheBundle", snapshot: server.snapshot, imports: 1, deltas: 1) {
      root, observation in
      try await Self.firstRun(origin: server.origin, root: root, observation: observation)
    }
  }

  func testBundleThenDeltaFromTheStore() throws {
    let origin = try XCTUnwrap(Self.refused)
    let server = try ReplayServer.start()
    try measurePath("bundleThenDelta", snapshot: server.snapshot, imports: 2, deltas: 1) {
      root, observation in
      let store = root.appendingPathComponent("store")
      _ = try await Self.firstRun(origin: origin, root: root, observation: observation)
      let engine = try SyncEngine(
        api: APIClient(origin: server.origin),
        store: SnapshotStore(root: store, trace: observation),
        trace: observation,
        temporaryDirectory: root.appendingPathComponent("scratch"))
      return try await engine.synchronize(progress: { observation.progress($0) })
    }
  }

  private static func bundled() async throws -> BundledDataset {
    let resources = try XCTUnwrap(Bundle.main.resourceURL)
    return try await BundledDataset.open(
      archive: resources.appendingPathComponent("directory.tsv.br"),
      entry: resources.appendingPathComponent("directory.json"))
  }

  private static func firstRun(origin: URL, root: URL, observation: Observation) async throws
    -> SnapshotManifest
  {
    let bundle = try await Self.bundled()
    let engine = try SyncEngine(
      api: APIClient(origin: origin),
      store: SnapshotStore(root: root.appendingPathComponent("store"), trace: observation),
      trace: observation,
      temporaryDirectory: root.appendingPathComponent("scratch"))
    return try await engine.firstRun(bundle: bundle, progress: { observation.progress($0) })
      .manifest
  }

  /// Runs `work` in a new directory for each iteration, and measures only the work.
  private func measurePath(
    _ path: String, snapshot: String, imports: Int, deltas: Int,
    _ work: @escaping @Sendable (URL, Observation) async throws -> SnapshotManifest
  ) throws {
    let metrics: [any XCTMetric] = [
      XCTCPUMetric(), XCTClockMetric(), XCTMemoryMetric(), XCTStorageMetric(),
    ]
    let options = XCTMeasureOptions()
    options.iterationCount = 10
    options.invocationOptions = [.manuallyStart, .manuallyStop]
    var stores: [Int] = []
    var observations: [Observation.Record] = []
    var failures: [String] = []
    measure(metrics: metrics, options: options) {
      let root = FileManager.default.temporaryDirectory.appendingPathComponent(
        UUID().uuidString)
      defer { try? FileManager.default.removeItem(at: root) }
      do {
        try Self.prepare(root)
        let observation = Observation()
        startMeasuring()
        let failure = Blocking.run {
          let manifest = try await work(root, observation)
          try observation.validate(manifest, snapshot: snapshot, imports: imports, deltas: deltas)
        }
        stopMeasuring()
        if let failure { throw failure }
        stores.append(try Observation.bytes(in: root.appendingPathComponent("store")))
        observations.append(observation.recorded())
      } catch { failures.append(String(describing: error)) }
    }
    XCTAssertEqual(failures, [])
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    try Self.prepare(root)
    let space = Observation(spaceRoot: root)
    if let failure = Blocking.run({
      let manifest = try await work(root, space)
      try space.validate(manifest, snapshot: snapshot, imports: imports, deltas: deltas)
    }) {
      throw failure
    }
    let spaceRecord = try space.spaceRecord()
    let record = Measurement(
      path: path, iterations: options.iterationCount, storeBytes: stores,
      observations: observations, space: spaceRecord)
    let attachment = XCTAttachment(
      data: try JSONEncoder().encode(record),
      uniformTypeIdentifier: "public.json")
    attachment.name = "measurement-\(path).json"
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  private static func prepare(_ root: URL) throws {
    try FileManager.default.createDirectory(
      at: root.appendingPathComponent("scratch"), withIntermediateDirectories: true)
  }

  private struct Measurement: Encodable {
    let path: String
    let iterations: Int
    let storeBytes: [Int]
    let observations: [Observation.Record]
    let space: Observation.SpaceRecord
  }
}

private final class Observation: TraceSink {
  struct Interval: Encodable {
    let stage: Int
    let rows: Int
    let milliseconds: Double
  }
  struct Record: Encodable {
    let intervals: [Interval]
    let phases: [TraceEvent]
  }
  struct SpaceRecord: Encodable {
    let observedPeakWorkingBytes: Int
    let observedPeakScratchBytes: Int
    let finalStoreBytes: Int
    let observedPeakWorkingAllocatedBytes: Int
    let observedPeakScratchAllocatedBytes: Int
    let finalStoreAllocatedBytes: Int
    let samples: Int
  }
  private struct State {
    var intervals: [Interval] = []
    var phases: [TraceEvent] = []
    var stage: Int?
    var started = ContinuousClock.now
    var peakWorking = 0
    var peakScratch = 0
    var peakWorkingAllocated = 0
    var peakScratchAllocated = 0
    var samples = 0
    var failure: (any Error)?
  }
  private let state = Mutex(State())
  private let spaceRoot: URL?

  init(spaceRoot: URL? = nil) { self.spaceRoot = spaceRoot }

  func record(_ event: TraceEvent) {
    state.withLock { $0.phases.append(event) }
    sampleSpace()
  }

  func progress(_ progress: SyncProgress) {
    let now = ContinuousClock.now
    state.withLock { state in
      if state.stage != progress.stage {
        if let stage = state.stage, stage != SyncProgress.transfer {
          state.intervals.append(
            Interval(
              stage: stage, rows: progress.rows,
              milliseconds: (now - state.started) / .milliseconds(1)))
        }
        state.stage = progress.stage
        state.started = now
      }
      if progress.stage == SyncProgress.identify, progress.done == progress.total {
        state.intervals.append(
          Interval(
            stage: progress.stage, rows: progress.rows,
            milliseconds: (now - state.started) / .milliseconds(1)))
        state.stage = nil
      }
    }
    sampleSpace()
  }

  func validate(_ manifest: SnapshotManifest, snapshot: String, imports: Int, deltas: Int) throws {
    let phases = state.withLock { $0.phases }
    guard manifest.snapshot.rawValue == snapshot, manifest.records > 0,
      phases.filter({ $0.phase == .stage && $0.outcome == .started }).count == imports,
      phases.filter({ $0.phase == .delta && $0.outcome == .completed }).count == deltas,
      !phases.contains(where: { $0.phase == .delta && $0.outcome == .rejected })
    else { throw MeasurementFailure.unexpectedPath }
  }

  func recorded() -> Record {
    state.withLock { Record(intervals: $0.intervals, phases: $0.phases) }
  }

  private func sampleSpace() {
    guard let root = spaceRoot else { return }
    do {
      let working = try DirectoryStorageSize.read(in: root)
      let scratch = try DirectoryStorageSize.read(in: root.appendingPathComponent("scratch"))
      state.withLock {
        $0.peakWorking = max($0.peakWorking, working.logicalBytes)
        $0.peakScratch = max($0.peakScratch, scratch.logicalBytes)
        $0.peakWorkingAllocated = max($0.peakWorkingAllocated, working.allocatedBytes)
        $0.peakScratchAllocated = max($0.peakScratchAllocated, scratch.allocatedBytes)
        $0.samples += 1
      }
    } catch { state.withLock { $0.failure = $0.failure ?? error } }
  }

  func spaceRecord() throws -> SpaceRecord {
    guard let root = spaceRoot else { throw MeasurementFailure.missingSpaceRoot }
    sampleSpace()
    let stored = try DirectoryStorageSize.read(in: root.appendingPathComponent("store"))
    return try state.withLock {
      if let failure = $0.failure { throw failure }
      guard $0.samples > 0, $0.peakWorking >= stored.logicalBytes,
        $0.peakWorkingAllocated >= stored.allocatedBytes
      else {
        throw MeasurementFailure.missingSpaceSample
      }
      return SpaceRecord(
        observedPeakWorkingBytes: $0.peakWorking, observedPeakScratchBytes: $0.peakScratch,
        finalStoreBytes: stored.logicalBytes,
        observedPeakWorkingAllocatedBytes: $0.peakWorkingAllocated,
        observedPeakScratchAllocatedBytes: $0.peakScratchAllocated,
        finalStoreAllocatedBytes: stored.allocatedBytes, samples: $0.samples)
    }
  }

  static func bytes(in directory: URL) throws -> Int {
    try DirectoryStorageSize.read(in: directory).logicalBytes
  }
}

private enum MeasurementFailure: Error {
  case unexpectedPath, missingSpaceRoot, missingSpaceSample
}

/// Runs async work to its end from the synchronous measure block.
private enum Blocking {
  static func run(_ work: @escaping @Sendable () async throws -> Void) -> (any Error)? {
    let failure = Mutex<(any Error)?>(nil)
    let done = DispatchSemaphore(value: 0)
    Task.detached(priority: .userInitiated) {
      do { try await work() } catch { failure.withLock { $0 = error } }
      done.signal()
    }
    done.wait()
    return failure.withLock { $0 }
  }
}

/// Serves the listing, the delta listing, and the delta that `ios-check device-record` recorded from the service.
private final class ReplayServer: Sendable {
  struct Entry: Decodable {
    let path: String
    let type: String
    let snapshot: String
    let file: String
  }

  let origin: URL
  let snapshot: String
  private let listener: NWListener

  private init(origin: URL, snapshot: String, listener: NWListener) {
    self.origin = origin
    self.snapshot = snapshot
    self.listener = listener
  }

  deinit { listener.cancel() }

  static func start() throws -> ReplayServer {
    let bundle = Bundle(for: DeviceMeasurementTests.self)
    guard let corpus = bundle.url(forResource: "device-measurement", withExtension: nil),
      let entries = try? JSONDecoder().decode(
        [Entry].self, from: Data(contentsOf: corpus.appendingPathComponent("replay.json"))),
      !entries.isEmpty
    else {
      throw XCTSkip("The service lists no delta from the bundled snapshot")
    }
    var replies: [String: Data] = [:]
    for entry in entries {
      let body = try Data(contentsOf: corpus.appendingPathComponent(entry.file))
      replies["GET \(entry.path) HTTP/1.1"] =
        Data(
          "HTTP/1.1 200 OK\r\nContent-Type: \(entry.type)\r\nX-Dataset-Snapshot: \(entry.snapshot)\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
            .utf8) + body
    }
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    let listener = try NWListener(using: parameters)
    let answers = replies
    listener.newConnectionHandler = { connection in
      connection.start(queue: .global())
      connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { data, _, _, _ in
        let line =
          String(decoding: data ?? Data(), as: UTF8.self)
          .split(separator: "\r\n", maxSplits: 1).first.map(String.init) ?? ""
        let reply =
          answers[line] ?? Data("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".utf8)
        connection.send(
          content: reply, completion: .contentProcessed { _ in connection.cancel() })
      }
    }
    let ready = DispatchSemaphore(value: 0)
    listener.stateUpdateHandler = { state in
      if case .ready = state { ready.signal() }
    }
    listener.start(queue: .global())
    ready.wait()
    let port = try XCTUnwrap(listener.port)
    let origin = try XCTUnwrap(URL(string: "http://127.0.0.1:\(port.rawValue)"))
    let snapshot = try XCTUnwrap(entries.first?.snapshot)
    return ReplayServer(origin: origin, snapshot: snapshot, listener: listener)
  }
}
