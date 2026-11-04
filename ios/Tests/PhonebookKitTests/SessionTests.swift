import Foundation
import Network
import Testing

@testable import PhonebookKit

/// A complete reply that leaves its connection open for the next request.
private func keptOpen(_ body: Data, type: String, headers: String = "") -> Data {
  Data(
    "HTTP/1.1 200 OK\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\n\(headers)\r\n"
      .utf8) + body
}

private let json = Data("{}".utf8)
private let body = Data("archive".utf8)

private func archive() throws -> DatasetArchive {
  try sampleArchive(bytes: body.count, digest: sha256Hex(body))
}

/// Serves JSON on every path and the archive on dataset file paths, each over a kept connection.
private func keptServer() async throws -> HTTPTestServer {
  let snapshot = try sampleSnapshot().rawValue
  return try await HTTPTestServer(finish: false, keepAlive: true) { request in
    request.hasPrefix("GET /api/datasets/")
      ? keptOpen(
        body, type: "application/octet-stream", headers: "X-Dataset-Snapshot: \(snapshot)\r\n")
      : keptOpen(json, type: "application/json")
  }
}

@Test(.timeLimit(.minutes(1))) func requestsOfOneClientShareOneSessionForJSONAndOneForTransfers()
  async throws
{
  let server = try await keptServer()
  defer { server.close() }
  let api = try APIClient(origin: server.origin)
  for _ in 0..<2 { #expect(try await api.get("/api/datasets").data == json) }
  for _ in 0..<2 {
    let file = try await api.download(archive())
    defer { try? FileManager.default.removeItem(at: file) }
    #expect(try Data(contentsOf: file) == body)
  }
  #expect(server.requestCount == 4)
  // The JSON session and the transfer session each keep one connection for both of their requests.
  #expect(server.connectionCount == 2)
}

@Test(.timeLimit(.minutes(1))) func aCancelledRequestLeavesTheSharedSessionUsable() async throws {
  let server = try await HTTPTestServer(finish: false, keepAlive: true) { request in
    request.hasPrefix("GET /api/held ")
      ? Data(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n[".utf8)
      : keptOpen(json, type: "application/json")
  }
  defer { server.close() }
  let transport = URLSessionTransport()
  let api = try APIClient(origin: server.origin, transport: transport)
  let unstarted = Task {
    withUnsafeCurrentTask { $0?.cancel() }
    return try await transport.send(URLRequest(url: server.origin.appendingPathComponent("api")))
  }
  await #expect(throws: CancellationError.self) { try await unstarted.value }
  #expect(server.requestCount == 0)
  var received = server.received.makeAsyncIterator()
  let held = Task { try await api.get("/api/held") }
  await received.next()
  held.cancel()
  await #expect(throws: CancellationError.self) { try await held.value }
  #expect(try await api.get("/api/datasets").data == json)
  #expect(server.requestCount == 2)
}

@Test(.timeLimit(.minutes(1))) func aTransferWaitsForAConnectionWhileJSONRequestsFailAtOnce()
  async throws
{
  // A listener that stopped leaves its port refusing connections.
  let origin = try await HTTPTestServer { _ in Data() }.origin
  let api = try APIClient(origin: origin)
  // A JSON request that waited would end with a timeout instead.
  let refused = await #expect(throws: URLError.self) { try await api.get("/api/datasets") }
  #expect(refused?.code == .cannotConnectToHost)
  let (waits, waited) = AsyncStream.makeStream(of: TransferProgress.self)
  let transfer = Task {
    try await api.download(archive()) { if $0.waiting { waited.yield($0) } }
  }
  var reports = waits.makeAsyncIterator()
  #expect(
    await reports.next()
      == TransferProgress(resumed: 0, received: 0, total: body.count, waiting: true))
  transfer.cancel()
  await #expect(throws: CancellationError.self) { try await transfer.value }
  let number = try #require(origin.port)
  let port = try #require(NWEndpoint.Port(rawValue: UInt16(number)))
  let snapshot = try sampleSnapshot().rawValue
  let server = try await HTTPTestServer(port: port) { _ in
    Data(
      "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nX-Dataset-Snapshot: \(snapshot)\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        .utf8) + body
  }
  // The session that held the cancelled wait sends the client's next transfer.
  let file = try await api.download(archive())
  defer { try? FileManager.default.removeItem(at: file) }
  #expect(try Data(contentsOf: file) == body)
  #expect(server.requestCount == 1)
}

@Test(.timeLimit(.minutes(1))) func aClientsSessionsGoAwayWithTheClient() async throws {
  let server = try await keptServer()
  defer { server.close() }
  weak var jsonSession: OwnedSession?
  weak var transferSession: OwnedSession?
  do {
    let transport = URLSessionTransport()
    let api = try APIClient(origin: server.origin, transport: transport)
    jsonSession = transport.owned
    transferSession = api.transfers
    #expect(try await api.get("/api/datasets").data == json)
    let file = try await api.download(archive())
    try FileManager.default.removeItem(at: file)
    withExtendedLifetime(api) { #expect(jsonSession != nil && transferSession != nil) }
  }
  // No task delegate holds an owner, so the last copy of the client invalidates both sessions.
  #expect(jsonSession == nil && transferSession == nil)
}
