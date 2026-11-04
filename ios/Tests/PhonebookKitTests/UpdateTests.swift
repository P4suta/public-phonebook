import Foundation
import PhonebookCore
import Testing

@testable import PhonebookKit

private let listingTag = "\"updated-listing\""
private let checkedAt = Date(timeIntervalSince1970: 1_800_000_000)
private let inexpensive = UpdatePath(expensive: false, constrained: false)
private let costlyPaths = [
  UpdatePath(expensive: true, constrained: false), UpdatePath(expensive: false, constrained: true),
  UpdatePath(expensive: true, constrained: true),
]

/// Serves the provider's updated revision with an ETag on its listing, and a 304 to a request that names it.
/// Without `deltas`, the listing links no delta, so the update needs the complete archive.
private func updatedServer(deltas: Bool, requests: RequestLog) async throws -> HTTPTestServer {
  var entries = try corpus("updated")
  if !deltas {
    entries = try entries.map { entry in
      guard entry.path == "/api/datasets" else { return entry }
      var listing = try #require(
        try JSONSerialization.jsonObject(with: entry.data) as? [String: Any])
      listing["datasetDeltas"] = nil
      let body = String(
        decoding: try JSONSerialization.data(withJSONObject: listing), as: UTF8.self)
      return CorpusEntry(
        revision: entry.revision, path: entry.path, status: entry.status, headers: entry.headers,
        body: body, encoding: nil)
    }
  }
  let responses = try Dictionary(
    uniqueKeysWithValues: entries.map { entry in
      var headers = entry.headers.map { "\($0.key): \($0.value)\r\n" }.joined()
      if entry.path == "/api/datasets" { headers += "ETag: \(listingTag)\r\n" }
      let body = try entry.data
      return (
        entry.path,
        Data(
          "HTTP/1.1 \(entry.status) OK\r\nConnection: close\r\n\(headers)Content-Length: \(body.count)\r\n\r\n"
            .utf8) + body
      )
    })
  return try await HTTPTestServer { request in
    let target = request.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
    requests.record(target)
    let tagged = request.split(separator: "\r\n").contains {
      $0.lowercased().hasPrefix("if-none-match:") && $0.hasSuffix(listingTag)
    }
    if target == "/api/datasets", tagged {
      return Data(
        "HTTP/1.1 304 Not Modified\r\nConnection: close\r\nETag: \(listingTag)\r\nContent-Length: 0\r\n\r\n"
          .utf8)
    }
    return responses[target] ?? notFoundResponse
  }
}

/// A store that saved the provider's baseline, as an installed app holds before an update.
private func baselineStore(in root: URL) async throws -> (SnapshotStore, SnapshotManifest) {
  let store = try SnapshotStore(root: root.appendingPathComponent("store"))
  let provider = try await corpusServer(corpus("baseline"))
  let manifest = try await SyncEngine(api: APIClient(origin: provider.origin), store: store)
    .synchronize(progress: { _ in })
  return (store, manifest)
}

private func updater(
  _ server: HTTPTestServer, _ store: SnapshotStore, _ records: MemoryUpdateRecords
) throws -> AutomaticUpdate {
  let api = try APIClient(origin: server.origin)
  return AutomaticUpdate(
    api: api, sync: SyncEngine(api: api, store: store), store: store, records: records,
    now: { checkedAt })
}

private func transferred(_ requests: RequestLog) -> Bool {
  requests.received.contains {
    $0.contains("/directory-delta-") || $0.hasSuffix("/directory.tsv.br")
  }
}

@Test(.timeLimit(.minutes(1))) func aNotModifiedListingStartsNoTransfer() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, baseline) = try await baselineStore(in: root)
  let requests = RequestLog()
  let server = try await updatedServer(deltas: true, requests: requests)
  let answered = Int(checkedAt.timeIntervalSince1970) - 2 * UpdateCheck.intervalSeconds
  let records = MemoryUpdateRecords(
    UpdateRecord(state: UpdateState(answeredAt: answered), etag: listingTag))
  let outcome = try await updater(server, store, records).check(path: inexpensive)
  #expect(outcome.read)
  #expect(outcome.start == nil)
  #expect(requests.ordered == ["/api/datasets"])
  #expect(records.load().state == UpdateState(answeredAt: Int(checkedAt.timeIntervalSince1970)))
  #expect(try await store.manifest()?.generation == baseline.generation)
}

/// A small delta and the complete archive each wait on every costly path, and start once the path turns inexpensive.
@Test(.timeLimit(.minutes(1)), arguments: costlyPaths, UpdateTransfer.allCases)
func automaticTransfersWaitForAnInexpensivePath(_ path: UpdatePath, _ transfer: UpdateTransfer)
  async throws
{
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, baseline) = try await baselineStore(in: root)
  let requests = RequestLog()
  let server = try await updatedServer(deltas: transfer == .delta, requests: requests)
  let records = MemoryUpdateRecords()
  let update = try updater(server, store, records)
  let waiting = try await update.check(path: path)
  #expect(waiting.read)
  #expect(waiting.start == nil)
  #expect(records.load().state.waiting == transfer)
  #expect(!transferred(requests))
  #expect(try await store.manifest()?.generation == baseline.generation)
  let started = try await update.pathChanged(inexpensive)
  #expect(started.start == UpdateStart(transfer: transfer, automatic: true, path: inexpensive))
  #expect(started.manifest?.previous == baseline.generation)
  #expect(records.load().state.waiting == nil)
  #expect(
    requests.received.contains {
      transfer == .delta ? $0.contains("/directory-delta-") : $0.hasSuffix("/directory.tsv.br")
    })
  // The transfer reused the checked listing, so the listing was read once.
  #expect(requests.ordered.filter { $0 == "/api/datasets" }.count == 1)
}

@Test(.timeLimit(.minutes(1))) func aTransferThePersonStartsUsesAnExpensivePath() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, baseline) = try await baselineStore(in: root)
  let requests = RequestLog()
  let server = try await updatedServer(deltas: true, requests: requests)
  let records = MemoryUpdateRecords()
  let manifest = try await updater(server, store, records).runPerson(
    path: UpdatePath(expensive: true, constrained: true))
  #expect(manifest.previous == baseline.generation)
  #expect(transferred(requests))
  #expect(records.load().state == UpdateState(answeredAt: Int(checkedAt.timeIntervalSince1970)))
}

@Test(.timeLimit(.minutes(1))) func aCheckWithinADayReadsNothing() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, _) = try await baselineStore(in: root)
  let requests = RequestLog()
  let server = try await updatedServer(deltas: true, requests: requests)
  let answered = Int(checkedAt.timeIntervalSince1970) - UpdateCheck.intervalSeconds + 1
  let records = MemoryUpdateRecords(UpdateRecord(state: UpdateState(answeredAt: answered)))
  let outcome = try await updater(server, store, records).check(path: inexpensive)
  #expect(!outcome.read)
  #expect(requests.ordered.isEmpty)
}
