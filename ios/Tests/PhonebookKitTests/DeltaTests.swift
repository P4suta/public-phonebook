import Foundation
import PhonebookCore
import Testing

@testable import PhonebookKit

private let savedSnapshot = String(repeating: "a", count: 64)
private let currentSnapshot = String(repeating: "b", count: 64)
private let foreignSnapshot = String(repeating: "c", count: 64)
private let listedArchive = String(repeating: "e", count: 64)
private let rowCounts = ["13": 4]
private let longPhone = "0312345678\u{1E}代表（０３）1234-5678"

/// Base rows in archive order: 0 図書館A, 1 閉館した図書館, 2 病院B, and 3 病院C.
private let baseLines = [
  ArchiveLine(name: "図書館A"),
  ArchiveLine(name: "閉館した図書館"),
  ArchiveLine(category: 1, name: "病院B", confirmation: "1"),
  ArchiveLine(category: 1, name: "病院C", phones: longPhone, origin: "0\u{1F}1", confirmation: "*"),
]

/// The target swaps both categories and both links, drops base row 1, and adds one row.
private let targetLines = [
  ArchiveLine(name: "新しい病院D", origin: "1"),
  ArchiveLine(name: "病院B", origin: "1", confirmation: "0"),
  ArchiveLine(name: "病院C", phones: longPhone, origin: "1\u{1F}0", confirmation: "*"),
  ArchiveLine(category: 1, name: "図書館A", origin: "1"),
]

private func sorted(_ lines: [ArchiveLine]) -> [ArchiveLine] {
  lines.sorted { Array($0.text.utf8).lexicographicallyPrecedes($1.text.utf8) }
}

private func targetHeaderObject() -> [String: Any] {
  var header = sampleHeaderObject(snapshot: "b", counts: rowCounts)
  header["categories"] = (header["categories"] as? [Any]).map { Array($0.reversed()) }
  header["links"] = (header["links"] as? [Any]).map { Array($0.reversed()) }
  return header
}

private func identity(_ snapshot: String, _ text: Data, archive: String = listedArchive)
  -> [String: Any]
{
  [
    "snapshot": snapshot, "archiveSha256": archive, "sha256": sha256Hex(text),
    "bytes": text.count, "contacts": rowCounts.values.reduce(0, +),
  ]
}

/// A delta from `baseLines` to `targetLines` whose parts each fault replaces.
private struct DeltaFixture {
  let baseText: Data
  let targetText: Data
  var signature = "public-phonebook-directory-delta\t1"
  var header: [String: Any]
  var targetHeaderLine: Data
  var instructions: [String]
  var terminated = true

  init(archive: String = listedArchive) throws {
    baseText = try archiveText(
      header: sampleHeaderObject(snapshot: "a", counts: rowCounts), lines: baseLines)
    targetText = try archiveText(header: targetHeaderObject(), lines: targetLines)
    targetHeaderLine = Data(targetText.split(separator: 0x0A, omittingEmptySubsequences: false)[1])
    header = [
      "base": identity(savedSnapshot, baseText),
      "target": identity(currentSnapshot, targetText, archive: archive),
      "kept": 3, "added": 1, "removed": 1,
      "categories": [1, 0], "provenances": [0], "links": [1, 0],
    ]
    instructions = ["+\t" + targetLines[0].text, "=\t2\t2", "=\t0\t1"]
  }

  var text: Data {
    get throws {
      var data = Data((signature + "\n").utf8)
      data += try JSONSerialization.data(withJSONObject: header, options: [.sortedKeys])
      data += Data("\n".utf8) + targetHeaderLine + Data("\n".utf8)
      data += Data(instructions.map { $0 + "\n" }.joined().utf8)
      return terminated ? data : data.dropLast()
    }
  }

  mutating func set(_ side: String, _ key: String, _ value: Any) {
    var archive = header[side] as? [String: Any] ?? [:]
    archive[key] = value
    header[side] = archive
  }
}

private func savedBase(in root: URL) async throws -> (SnapshotStore, SnapshotManifest) {
  let store = try SnapshotStore(root: root.appendingPathComponent("store"))
  let manifest = try await publish(sorted(baseLines), to: store, snapshot: "a", counts: rowCounts)
  return (store, manifest)
}

private func rebuild(
  _ fixture: DeltaFixture, in root: URL, compressed: Data? = nil, decodedBytes: Int? = nil
) async throws -> (DeltaAdmission, Data) {
  let (store, manifest) = try await savedBase(in: root)
  let text = try fixture.text
  let url = root.appendingPathComponent(UUID().uuidString + ".br")
  try (compressed ?? brotli(text)).write(to: url)
  let output = root.appendingPathComponent(UUID().uuidString)
  let applier = DirectoryDeltaApplier(
    url: url, decodedBytes: decodedBytes ?? text.count, target: try SnapshotID(currentSnapshot),
    targetArchive: try SnapshotID(listedArchive))
  let admission = try await applier.rebuild(
    from: try await DeltaBase(store: store, manifest: manifest), into: output)
  return (admission, try Data(contentsOf: output))
}

@Test func storedRowsReencodeTheirArchiveLines() async throws {
  let lines = sorted([
    ArchiveLine(
      phones: "03-5321-1111\u{1F}0353211112\u{1E}代表（０３）5321-1112", website: "https://example.com/",
      origin: "0\u{1F}1", confirmation: "1"),
    ArchiveLine(category: 1, region: "13", name: "都の窓口", address: "", confirmation: "*"),
    ArchiveLine(name: "携帯の窓口", phones: "090-1234-5678\u{1F}03 5321 1113"),
  ])
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let store = try SnapshotStore(root: root)
  let manifest = try await publish(lines, to: store, counts: ["13": lines.count])
  let expected = lines.map { Data($0.text.utf8) }
  #expect(
    try await store.archiveRows(generation: manifest.generation, from: 0, count: 3) == expected)
  #expect(
    try await store.archiveRows(generation: manifest.generation, from: 1, count: 2)
      == Array(expected[1...]))
  for (start, count) in [(2, 2), (-1, 1), (0, 0), (0, SnapshotStore.archiveRowBatch + 1)] {
    await #expect(throws: ImportError.self, "\(start), \(count)") {
      try await store.archiveRows(generation: manifest.generation, from: start, count: count)
    }
  }
}

@Test func deltasRebuildTheTargetArchiveByteForByte() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let fixture = try DeltaFixture()
  let (admission, rebuilt) = try await rebuild(fixture, in: root)
  #expect(admission == .apply)
  #expect(rebuilt == fixture.targetText)
}

private enum DeltaFault: CaseIterable, Sendable {
  case signature, targetDigest, targetLength, baseSnapshot, baseRows, baseDictionary,
    sameSnapshots, targetHeaderSnapshot, listedTarget, instructionCounts, extraInstruction,
    copyOutOfRange, copyOverlap, nullIndex, outOfRangeIndex, malformedInstruction,
    decodedLength, unterminated, truncated

  var admission: DeltaAdmission? {
    switch self {
    case .targetDigest: .digestMismatch
    case .targetLength: .lengthMismatch
    case .baseSnapshot, .baseRows, .baseDictionary: .baseMismatch
    case .unterminated, .truncated: nil
    default: .malformed
    }
  }

  func apply(to fixture: inout DeltaFixture) {
    switch self {
    case .signature: fixture.signature = "public-phonebook-directory-delta\t2"
    case .targetDigest: fixture.set("target", "sha256", foreignSnapshot)
    case .targetLength: fixture.set("target", "bytes", fixture.targetText.count + 1)
    case .baseSnapshot: fixture.set("base", "snapshot", foreignSnapshot)
    case .baseRows:
      fixture.set("base", "contacts", 5)
      fixture.header["removed"] = 2
    case .baseDictionary: fixture.header["provenances"] = [0, 0]
    case .sameSnapshots: fixture.set("target", "snapshot", savedSnapshot)
    case .targetHeaderSnapshot:
      fixture.targetHeaderLine = Data(
        String(decoding: fixture.targetHeaderLine, as: UTF8.self)
          .replacingOccurrences(of: currentSnapshot, with: foreignSnapshot).utf8)
    case .listedTarget:
      fixture.set("target", "snapshot", foreignSnapshot)
      fixture.targetHeaderLine = Data(
        String(decoding: fixture.targetHeaderLine, as: UTF8.self)
          .replacingOccurrences(of: currentSnapshot, with: foreignSnapshot).utf8)
    case .instructionCounts:
      fixture.header["kept"] = 2
      fixture.header["added"] = 2
      fixture.header["removed"] = 2
    case .extraInstruction: fixture.instructions.append("+\t" + targetLines[1].text)
    case .copyOutOfRange: fixture.instructions[2] = "=\t3\t2"
    case .copyOverlap: fixture.instructions[2] = "=\t3\t1"
    case .nullIndex: fixture.header["categories"] = [NSNull(), 0]
    case .outOfRangeIndex: fixture.header["links"] = [2, 0]
    case .malformedInstruction: fixture.instructions[2] = "=\t00\t1"
    case .unterminated: fixture.terminated = false
    case .decodedLength, .truncated: break
    }
  }
}

@Test(.timeLimit(.minutes(1)), arguments: DeltaFault.allCases)
private func everyDeltaFaultIsRejectedBeforeStaging(_ fault: DeltaFault) async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  var fixture = try DeltaFixture()
  fault.apply(to: &fixture)
  var compressed: Data?
  if fault == .truncated {
    compressed = try brotli(fixture.text).dropLast(4)
  }
  let decodedBytes = try fault == .decodedLength ? fixture.text.count + 1 : nil
  if let admission = fault.admission {
    let result = try await rebuild(
      fixture, in: root, compressed: compressed, decodedBytes: decodedBytes)
    #expect(result.0 == admission)
  } else {
    await #expect(throws: (any Error).self) {
      try await rebuild(fixture, in: root, compressed: compressed, decodedBytes: decodedBytes)
    }
  }
}

private enum DeltaSync: CaseIterable, Sendable {
  case applied, rejectedDelta, unlistedBase, unknownFormat, unlinked, unsaved, completeAlsoFails,
    cancelled
}

private let unknownDeltaFormat = "public-phonebook-directory-delta/2"

private func json(_ data: Data, snapshot: String) -> Data {
  httpResponse(
    data, headers: "Content-Length: \(data.count)\r\nX-Dataset-Snapshot: \(snapshot)\r\n")
}

private func binary(_ data: Data, snapshot: String) -> Data {
  Data(
    "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: application/octet-stream\r\nX-Dataset-Snapshot: \(snapshot)\r\nContent-Length: \(data.count)\r\n\r\n"
      .utf8) + data
}

/// Paths the delta server answers, so a test can tell which downloads the client made.
private struct DeltaRoutes {
  let listing = "/api/dataset-deltas?snapshot=\(currentSnapshot)"
  let delta: String
  let archive: String
}

private func deltaServer(_ mode: DeltaSync, requests: RequestLog) async throws -> (
  HTTPTestServer, DeltaRoutes
) {
  let archive = try brotli(DeltaFixture().targetText)
  let archiveDigest = sha256Hex(archive)
  var fixture = try DeltaFixture(archive: archiveDigest)
  if [.rejectedDelta, .completeAlsoFails].contains(mode) {
    fixture.set("target", "sha256", foreignSnapshot)
  }
  let text = try fixture.text
  let delta = try brotli(text)
  let base = mode == .unlistedBase ? foreignSnapshot : savedSnapshot
  let file = "directory-delta-\(base).tsv.br"
  let routes = DeltaRoutes(
    delta: "/api/datasets/\(currentSnapshot)/\(sha256Hex(delta))/\(file)",
    archive: "/api/datasets/\(currentSnapshot)/\(archiveDigest)/directory.tsv.br")
  let manifest = datasetsFixture(
    snapshot: currentSnapshot, contacts: 4, sha256: archiveDigest, bytes: archive.count,
    url: routes.archive, deltas: mode != .unlinked)
  let format = mode == .unknownFormat ? unknownDeltaFormat : DatasetDelta.format
  // A delta in a later format lists other fields, and the client skips it in every mode.
  let listing = Data(
    """
    {"snapshot":"\(currentSnapshot)","archiveSha256":"\(archiveDigest)","deltas":[\
    {"base":"\(base)","format":"\(unknownDeltaFormat)","url":"\(routes.delta)"},\
    {"base":"\(base)","baseArchiveSha256":"\(listedArchive)","file":"\(file)","format":"\(format)",\
    "sha256":"\(sha256Hex(delta))","bytes":\(delta.count),"uncompressedSha256":"\(sha256Hex(text))",\
    "uncompressedBytes":\(text.count),"url":"\(routes.delta)"}]}
    """.utf8)
  let served = mode == .completeAlsoFails ? archive.dropLast() : archive
  let server = try await HTTPTestServer { request in
    let target = request.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
    requests.record(target)
    switch target {
    case routes.archive: return binary(served, snapshot: currentSnapshot)
    case routes.delta: return binary(delta, snapshot: currentSnapshot)
    case routes.listing: return json(listing, snapshot: currentSnapshot)
    case "/api/datasets": return json(manifest, snapshot: currentSnapshot)
    default: return notFoundResponse
    }
  }
  return (server, routes)
}

@Test(.timeLimit(.minutes(1)), arguments: DeltaSync.allCases)
private func synchronizationAppliesDeltasAndFallsBackToTheCompleteArchive(_ mode: DeltaSync)
  async throws
{
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let store = try SnapshotStore(root: root)
  let original =
    mode == .unsaved
    ? nil : try await publish(sorted(baseLines), to: store, snapshot: "a", counts: rowCounts)
  let requests = RequestLog()
  let (server, routes) = try await deltaServer(mode, requests: requests)
  let engine = SyncEngine(api: try APIClient(origin: server.origin), store: store)
  let operation = Task {
    try await engine.synchronize { value in
      if mode == .cancelled, value > 0 { withUnsafeCurrentTask { $0?.cancel() } }
    }
  }
  let requested = { requests.received }
  if [.completeAlsoFails, .cancelled].contains(mode) {
    await #expect(throws: (any Error).self) { try await operation.value }
    #expect(try await store.manifest()?.generation == original?.generation)
    #expect(requested().contains(routes.delta))
    #expect(requested().contains(routes.archive) == (mode == .completeAlsoFails))
    return
  }
  let result = try await operation.value
  #expect(result.snapshot.rawValue == currentSnapshot)
  #expect(result.previous == original?.generation)
  let names = try await store.contacts(generation: result.generation, ids: [1, 2, 3, 4]).map(\.name)
  #expect(names == sorted(targetLines).map(\.name))
  let listed = [DeltaSync.applied, .rejectedDelta, .unlistedBase, .unknownFormat].contains(mode)
  #expect(requested().contains(routes.listing) == listed)
  #expect(requested().contains(routes.delta) == [.applied, .rejectedDelta].contains(mode))
  #expect(requested().contains(routes.archive) == (mode != .applied))
}
