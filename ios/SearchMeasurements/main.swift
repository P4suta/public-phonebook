import Darwin
import Foundation
import PhonebookCore
import PhonebookKit
import PhonebookRanking

private struct Fixture: Decodable {
  struct Query: Decodable {
    let query: String
    let hits: [[Int64]]
  }
  let snapshot: String
  let contacts: Int
  let queries: [Query]
}

private struct Latency: Encodable {
  let p50: Double
  let p95: Double
  let p99: Double
  let maximum: Double
}

private struct Measurement: Encodable {
  let mode: String
  let platform: String
  let snapshot: String
  let contacts: Int
  let startupMilliseconds: Double
  let baselineResidentBytes: Int64
  let peakResidentBytes: Int64
  let storeBytes: UInt64?
  let comparedQueries: Int
  let latencyMilliseconds: Latency?
  let budgets: Budgets?
}

private struct Budgets: Encodable {
  let maximumStartupMilliseconds = 1000.0
  let maximumResidentBytes: Int64 = 250_000_000
  let maximumP95Milliseconds = 19.133292
  let startup: Bool
  let memory: Bool
  let latency: Bool
  let passed: Bool

  init(startup: Bool, memory: Bool, latency: Bool) {
    self.startup = startup
    self.memory = memory
    self.latency = latency
    passed = startup && memory && latency
  }
}

private struct Offline: HTTPTransport {
  func send(_ request: URLRequest) async throws -> HTTPResult {
    throw URLError(.notConnectedToInternet)
  }
}

private func milliseconds(_ start: ContinuousClock.Instant) -> Double {
  let duration = start.duration(to: .now).components
  return Double(duration.seconds) * 1000 + Double(duration.attoseconds) / 1_000_000_000_000_000
}

private func peakResidentBytes() throws -> Int64 {
  var usage = rusage()
  guard getrusage(RUSAGE_SELF, &usage) == 0 else { throw CocoaError(.fileReadUnknown) }
  return Int64(usage.ru_maxrss)
}

private func bytes(in directory: URL) throws -> UInt64 {
  var pending = [directory]
  var total: UInt64 = 0
  while let current = pending.popLast() {
    for file in try FileManager.default.contentsOfDirectory(
      at: current, includingPropertiesForKeys: nil)
    {
      var isDirectory: ObjCBool = false
      guard FileManager.default.fileExists(atPath: file.path, isDirectory: &isDirectory) else {
        continue
      }
      if isDirectory.boolValue {
        pending.append(file)
      } else {
        let handle = try FileHandle(forReadingFrom: file)
        total += try handle.seekToEnd()
        try handle.close()
      }
    }
  }
  return total
}

private func measure(_ mode: String, directory: URL, fixture: Fixture, output: URL) async throws {
  let baseline = try peakResidentBytes()
  let start = ContinuousClock.now
  let startup: Double
  let latency: Latency?
  let count: Int
  let storeBytes: UInt64?
  if mode == "core" {
    let files = try SearchArtifactFiles.open(directory: directory)
    let admitted = try files.admit()
    let scorer = try admitted.index.scorer(admitted.ranking)
    startup = milliseconds(start)
    for query in fixture.queries.prefix(32) { _ = try scorer.search(query.query) }
    var times: [Double] = []
    for query in fixture.queries {
      let before = ContinuousClock.now
      let result = try scorer.search(query.query)
      times.append(milliseconds(before))
      guard result.map({ [Int64($0.row), $0.score] }) == query.hits else {
        throw RankingError.identityMismatch
      }
    }
    let sorted = times.sorted()
    func percentile(_ fraction: Double) -> Double {
      sorted[max(0, Int(ceil(Double(sorted.count) * fraction)) - 1)]
    }
    latency = Latency(
      p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), maximum: percentile(1))
    count = fixture.queries.count
    storeBytes = nil
  } else if mode == "import" {
    let root = output.deletingLastPathComponent().appendingPathComponent("saved-store")
    let store = try SnapshotStore(root: root)
    guard let origin = URL(string: "https://example.com") else { throw ServiceError.invalidURL }
    let api = try APIClient(origin: origin, transport: Offline())
    let archive = try await BundledDataset.open(
      archive: directory.appendingPathComponent("directory.tsv.br"),
      entry: directory.appendingPathComponent("directory.json"))
    let source = SearchArtifactRepository(api: api, bundledDirectory: directory)
    let saved = try await SyncEngine(api: api, store: store, searchArtifacts: source).firstRun(
      bundle: archive, progress: { _ in })
    startup = milliseconds(start)
    guard saved.manifest.snapshot.rawValue == fixture.snapshot,
      saved.manifest.records == fixture.contacts, saved.manifest.rankedSearch == true
    else { throw RankingError.identityMismatch }
    storeBytes = try bytes(in: root)
    latency = nil
    count = 0
  } else if mode == "saved" {
    let root = output.deletingLastPathComponent().appendingPathComponent("saved-store")
    let store = try SnapshotStore(root: root)
    guard let manifest = try await store.manifest(),
      let scorer = try await store.rankedSearch(generation: manifest.generation),
      manifest.snapshot.rawValue == fixture.snapshot, manifest.records == fixture.contacts
    else { throw RankingError.identityMismatch }
    startup = milliseconds(start)
    let mapping = try Data(
      contentsOf: root.appendingPathComponent(manifest.generation.uuidString + ".search-rows"))
    for query in fixture.queries.prefix(32) { _ = try scorer.search(query.query) }
    var times: [Double] = []
    for query in fixture.queries {
      let before = ContinuousClock.now
      let result = try scorer.search(query.query)
      times.append(milliseconds(before))
      let expected = mapping.withUnsafeBytes { raw in
        query.hits.map { hit in
          [
            Int64(
              UInt32(
                littleEndian: raw.loadUnaligned(fromByteOffset: Int(hit[0]) * 4, as: UInt32.self))),
            hit[1],
          ]
        }
      }
      guard result.map({ [$0.id, $0.score] }) == expected else {
        throw RankingError.identityMismatch
      }
    }
    let sorted = times.sorted()
    func percentile(_ fraction: Double) -> Double {
      sorted[max(0, Int(ceil(Double(sorted.count) * fraction)) - 1)]
    }
    latency = Latency(
      p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), maximum: percentile(1))
    count = fixture.queries.count
    storeBytes = try bytes(in: root)
  } else {
    throw RankingError.invalidArtifact
  }
  let peak = try peakResidentBytes()
  let budgets =
    mode == "saved"
    ? latency.map {
      Budgets(startup: startup <= 1000, memory: peak <= 250_000_000, latency: $0.p95 <= 19.133292)
    } : nil
  let record = Measurement(
    mode: mode, platform: ProcessInfo.processInfo.operatingSystemVersionString,
    snapshot: fixture.snapshot, contacts: fixture.contacts, startupMilliseconds: startup,
    baselineResidentBytes: baseline, peakResidentBytes: peak, storeBytes: storeBytes,
    comparedQueries: count, latencyMilliseconds: latency, budgets: budgets)
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
  try encoder.encode(record).write(to: output)
  print(
    "PASS: \(mode) measured \(fixture.contacts) contacts and compared \(count) complete rankings")
}

do {
  let args = CommandLine.arguments
  guard args.count == 5 else { throw RankingError.invalidArtifact }
  let fixture = try JSONDecoder().decode(
    Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: args[3])))
  guard fixture.queries.count == 2200 else { throw RankingError.invalidArtifact }
  try await measure(
    args[1], directory: URL(fileURLWithPath: args[2]), fixture: fixture,
    output: URL(fileURLWithPath: args[4]))
} catch {
  FileHandle.standardError.write(Data("Search measurement failed: \(error)\n".utf8))
  exit(1)
}
