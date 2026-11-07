import Darwin
import Foundation
import Network
import Synchronization
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

private final class SessionOriginLease: Sendable {
  private let descriptor: Int32
  let port: NWEndpoint.Port

  init() throws {
    let descriptor = Darwin.open(
      "/tmp/public-phonebook-session-origin.lock", O_CREAT | O_RDWR | O_CLOEXEC, mode_t(0o600))
    guard descriptor != -1 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    let selected: NWEndpoint.Port
    do {
      guard flock(descriptor, LOCK_EX) == 0 else {
        throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
      }
      func boundary(_ name: String) throws -> Int32 {
        var value: Int32 = 0
        var size = MemoryLayout<Int32>.size
        guard sysctlbyname(name, &value, &size, nil, 0) == 0 else {
          throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        return value
      }
      let lower = try min(
        boundary("net.inet.ip.portrange.first"), boundary("net.inet.ip.portrange.last"))
      guard (1025...65_535).contains(lower), let port = NWEndpoint.Port(rawValue: UInt16(lower - 1))
      else { throw POSIXError(.EADDRNOTAVAIL) }
      selected = port
    } catch {
      Darwin.close(descriptor)
      throw error
    }
    self.descriptor = descriptor
    port = selected
  }

  deinit { Darwin.close(descriptor) }
}

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

@Test(.timeLimit(.minutes(1)))
func requestsOfOneClientShareOneSessionForJSONAndOneForEachTransferOrigin()
  async throws
{
  let server = try await keptServer()
  defer { server.close() }
  let api = try APIClient(origin: server.origin)
  for _ in 0..<2 { #expect(try await api.get("/api/datasets").data == json) }
  for paths in [NetworkPaths.every, .every, .inexpensive, .inexpensive] {
    let file = try await api.download(archive(), paths: paths)
    defer { try? FileManager.default.removeItem(at: file) }
    #expect(try Data(contentsOf: file) == body)
  }
  #expect(server.requestCount == 6)
  // The JSON session and each transfer session keep one connection for both of their requests.
  #expect(server.connectionCount == 3)
}

@Test func eachTransferOriginTakesItsOwnSession() throws {
  let api = try APIClient(origin: #require(URL(string: "https://www.dial.page")))
  var sessions = Set<ObjectIdentifier>()
  for paths in NetworkPaths.allCases {
    #expect(paths.waitsForConnectivity == (paths == .every))
    let session = api.transferSession(for: paths)
    #expect(session.configuration.waitsForConnectivity == paths.waitsForConnectivity)
    #expect(session.configuration.httpCookieStorage == nil)
    sessions.insert(ObjectIdentifier(session))
  }
  #expect(sessions.count == NetworkPaths.allCases.count)
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

@Test(.timeLimit(.minutes(1)))
func aPersonsTransferWaitsWhileJSONRequestsAndAutomaticTransfersFailAtOnce()
  async throws
{
  let lease = try SessionOriginLease()
  defer { withExtendedLifetime(lease) {} }
  let unavailable = try await HTTPTestServer(port: lease.port) { _ in Data() }
  let origin = unavailable.origin
  await unavailable.stopListening()
  let api = try APIClient(origin: origin)
  // A JSON request that waited would end with a timeout instead.
  let refused = await #expect(throws: URLError.self) { try await api.get("/api/datasets") }
  #expect(refused?.code == .cannotConnectToHost)
  // An automatic transfer fails at once too, so the update decision starts it again.
  let automaticWaits = Mutex(0)
  let automatic = await #expect(throws: URLError.self) {
    try await api.download(archive(), paths: .inexpensive) { report in
      if report.waiting { automaticWaits.withLock { $0 += 1 } }
    }
  }
  #expect(automatic?.code == .cannotConnectToHost)
  #expect(automaticWaits.withLock { $0 } == 0)
  let (waits, waited) = AsyncStream.makeStream(of: TransferProgress.self)
  let transfer = Task {
    try await api.download(archive(), paths: .every) { if $0.waiting { waited.yield($0) } }
  }
  var reports = waits.makeAsyncIterator()
  #expect(
    await reports.next()
      == TransferProgress(resumed: 0, received: 0, total: body.count, waiting: true))
  transfer.cancel()
  await #expect(throws: CancellationError.self) { try await transfer.value }
  let snapshot = try sampleSnapshot().rawValue
  let server = try await HTTPTestServer(port: lease.port) { _ in
    Data(
      "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nX-Dataset-Snapshot: \(snapshot)\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        .utf8) + body
  }
  // The session that held the cancelled wait sends the client's next transfer.
  let file = try await api.download(archive())
  defer { try? FileManager.default.removeItem(at: file) }
  #expect(try Data(contentsOf: file) == body)
  #expect(server.requestCount == 1)
  await server.stopListening()
}

@Test(.timeLimit(.minutes(1))) func aClientsSessionsGoAwayWithTheClient() async throws {
  let server = try await keptServer()
  defer { server.close() }
  weak var jsonSession: OwnedSession?
  weak var waitingSession: OwnedSession?
  weak var immediateSession: OwnedSession?
  do {
    let transport = URLSessionTransport()
    let api = try APIClient(origin: server.origin, transport: transport)
    jsonSession = transport.owned
    waitingSession = api.waitingTransfers
    immediateSession = api.immediateTransfers
    #expect(try await api.get("/api/datasets").data == json)
    for paths in NetworkPaths.allCases {
      let file = try await api.download(archive(), paths: paths)
      try FileManager.default.removeItem(at: file)
    }
    withExtendedLifetime(api) {
      #expect(jsonSession != nil && waitingSession != nil && immediateSession != nil)
    }
  }
  // No task delegate holds an owner, so the last copy of the client invalidates every session.
  #expect(jsonSession == nil && waitingSession == nil && immediateSession == nil)
}
