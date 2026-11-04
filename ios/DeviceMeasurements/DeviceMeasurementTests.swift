import Foundation
import Network
import PhonebookKit
import Synchronization
import XCTest

/// Measures the first run's three paths in the host app on a physical iPhone.
/// Each test attaches every metric's values as JSON, which `ios-check device-record` reads.
final class DeviceMeasurementTests: XCTestCase {
  /// The discard port refuses the listing at once, so the first run saves the bundled snapshot alone.
  private static let refused = URL(string: "http://127.0.0.1:9")

  func testBundledImport() throws {
    let origin = try XCTUnwrap(Self.refused)
    try measurePath("bundledImport") { root in
      try await Self.firstRun(
        origin: origin, store: root.appendingPathComponent("store"), root: root)
    }
  }

  func testDeltaFromTheBundle() throws {
    let server = try ReplayServer.start()
    try measurePath("deltaFromTheBundle") { root in
      try await Self.firstRun(
        origin: server.origin, store: root.appendingPathComponent("store"), root: root)
    }
  }

  func testBundleThenDeltaFromTheStore() throws {
    let origin = try XCTUnwrap(Self.refused)
    let server = try ReplayServer.start()
    try measurePath("bundleThenDelta") { root in
      let store = root.appendingPathComponent("store")
      try await Self.firstRun(origin: origin, store: store, root: root)
      let engine = try SyncEngine(
        api: APIClient(origin: server.origin), store: SnapshotStore(root: store),
        temporaryDirectory: root.appendingPathComponent("scratch"))
      _ = try await engine.synchronize(progress: { _ in })
    }
  }

  private static func firstRun(origin: URL, store: URL, root: URL) async throws {
    let resources = try XCTUnwrap(Bundle.main.resourceURL)
    let bundle = try await BundledDataset.open(
      archive: resources.appendingPathComponent("directory.tsv.br"),
      entry: resources.appendingPathComponent("directory.json"))
    let engine = try SyncEngine(
      api: APIClient(origin: origin), store: SnapshotStore(root: store),
      temporaryDirectory: root.appendingPathComponent("scratch"))
    _ = try await engine.firstRun(bundle: bundle, progress: { _ in })
  }

  /// Runs `work` in a new directory for each iteration, and measures only the work.
  private func measurePath(_ path: String, _ work: @escaping @Sendable (URL) async throws -> Void)
    throws
  {
    let sink = MetricSink()
    let measured: [any XCTMetric] = [
      XCTCPUMetric(), XCTClockMetric(), XCTMemoryMetric(), XCTStorageMetric(),
    ]
    let metrics: [any XCTMetric] = measured.map { RecordedMetric($0, sink: sink) }
    let options = XCTMeasureOptions()
    options.invocationOptions = [.manuallyStart, .manuallyStop]
    var stores: [Int] = []
    var failures: [String] = []
    measure(metrics: metrics, options: options) {
      let root = FileManager.default.temporaryDirectory.appendingPathComponent(
        UUID().uuidString)
      defer { try? FileManager.default.removeItem(at: root) }
      startMeasuring()
      let failure = Blocking.run { try await work(root) }
      stopMeasuring()
      if let failure { failures.append(String(describing: failure)) }
      stores.append(Self.bytes(in: root.appendingPathComponent("store")))
    }
    XCTAssertEqual(failures, [])
    let record: [String: Any] = [
      "path": path, "metrics": sink.recorded(), "storeBytes": stores,
    ]
    let attachment = XCTAttachment(
      data: try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]),
      uniformTypeIdentifier: "public.json")
    attachment.name = "measurement-\(path).json"
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  /// The bytes of every file under `directory`.
  private static func bytes(in directory: URL) -> Int {
    let files = FileManager.default.enumerator(
      at: directory, includingPropertiesForKeys: [.fileSizeKey])
    return (files?.allObjects as? [URL] ?? []).reduce(0) {
      $0 + ((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
    }
  }
}

/// Runs async work to its end from the synchronous measure block.
private enum Blocking {
  static func run(_ work: @escaping @Sendable () async throws -> Void) -> (any Error)? {
    let failure = Mutex<(any Error)?>(nil)
    let done = DispatchSemaphore(value: 0)
    Task.detached {
      do { try await work() } catch { failure.withLock { $0 = error } }
      done.signal()
    }
    done.wait()
    return failure.withLock { $0 }
  }
}

/// Collects every measurement that the wrapped metrics report, keyed by the metric's identifier.
private final class MetricSink: Sendable {
  private let values = Mutex<[String: (name: String, unit: String, values: [Double])]>([:])

  func add(_ measurements: [XCTPerformanceMeasurement]) {
    values.withLock { values in
      for measurement in measurements {
        let current =
          values[measurement.identifier]
          ?? (measurement.displayName, measurement.unitSymbol, [])
        values[measurement.identifier] = (
          current.name, current.unit, current.values + [measurement.doubleValue]
        )
      }
    }
  }

  func recorded() -> [[String: Any]] {
    values.withLock { values in
      values.keys.sorted().compactMap { key in
        values[key].map {
          ["identifier": key, "name": $0.name, "unit": $0.unit, "values": $0.values]
        }
      }
    }
  }
}

/// Reports what the wrapped metric reports, and keeps a copy in the shared sink.
private final class RecordedMetric: NSObject, XCTMetric, @unchecked Sendable {
  private let inner: any XCTMetric
  private let sink: MetricSink

  init(_ inner: any XCTMetric, sink: MetricSink) {
    self.inner = inner
    self.sink = sink
  }

  func copy(with zone: NSZone? = nil) -> Any {
    RecordedMetric((inner.copy(with: zone) as? any XCTMetric) ?? inner, sink: sink)
  }

  func willBeginMeasuring() { inner.willBeginMeasuring?() }

  func didStopMeasuring() { inner.didStopMeasuring?() }

  func reportMeasurements(
    from startTime: XCTPerformanceMeasurementTimestamp,
    to endTime: XCTPerformanceMeasurementTimestamp
  ) throws -> [XCTPerformanceMeasurement] {
    let measurements = try inner.reportMeasurements(from: startTime, to: endTime)
    sink.add(measurements)
    return measurements
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
  private let listener: NWListener

  private init(origin: URL, listener: NWListener) {
    self.origin = origin
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
    return ReplayServer(origin: origin, listener: listener)
  }
}
