import CryptoKit
import Foundation
import Network
import PhonebookCore
import Synchronization
import Testing

@testable import PhonebookKit

private final class ServerState: Sendable {
  struct Value {
    var count = 0
    var connections: [NWConnection] = []
  }
  let value = Mutex(Value())
}

final class HTTPTestServer: Sendable {
  private let listener: NWListener
  private let requests = ServerState()
  let received: AsyncStream<Void>
  let origin: URL

  /// Without `finish`, each connection stays open after its reply until `close()`, so a test ends a cut reply only after the client reports its bytes.
  /// URLSession can drop the bytes of a cut reply that closes at once, while a complete reply arrives whole.
  init(
    finish: Bool = true, response: @escaping @Sendable (String) -> Data
  ) async throws {
    let (received, continuation) = AsyncStream.makeStream(of: Void.self)
    self.received = received
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    let listener = try NWListener(using: parameters)
    self.listener = listener
    let requests = self.requests
    listener.newConnectionHandler = { connection in
      requests.value.withLock { $0.connections.append(connection) }
      connection.start(queue: .global())
      Self.receive(
        connection, prefix: Data(), requests: requests, received: continuation,
        finish: finish, response: response)
    }
    let ready = Mutex<CheckedContinuation<Void, any Error>?>(nil)
    try await withCheckedThrowingContinuation { continuation in
      ready.withLock { $0 = continuation }
      listener.stateUpdateHandler = { state in
        switch state {
        case .ready:
          ready.withLock { value in
            defer { value = nil }
            return value
          }?.resume()
        case .failed(let error):
          ready.withLock { value in
            defer { value = nil }
            return value
          }?.resume(throwing: error)
        default: break
        }
      }
      listener.start(queue: .global())
    }
    let port = try #require(listener.port)
    origin = try #require(URL(string: "http://127.0.0.1:\(port.rawValue)"))
  }

  private static func receive(
    _ connection: NWConnection, prefix: Data, requests: ServerState,
    received: AsyncStream<Void>.Continuation, finish: Bool,
    response: @escaping @Sendable (String) -> Data
  ) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384 - prefix.count) {
      data, _, complete, error in
      let bytes = prefix + (data ?? Data())
      guard bytes.range(of: Data("\r\n\r\n".utf8)) != nil else {
        guard !complete, error == nil, bytes.count < 16_384 else {
          connection.cancel()
          return
        }
        receive(
          connection, prefix: bytes, requests: requests, received: received,
          finish: finish, response: response)
        return
      }
      requests.value.withLock { $0.count += 1 }
      received.yield(())
      connection.send(
        content: response(String(decoding: bytes, as: UTF8.self)),
        completion: .contentProcessed { _ in
          if finish { connection.cancel() }
        })
    }
  }

  /// Closes every connection that is still open.
  func close() {
    for connection in requests.value.withLock({ $0.connections }) { connection.cancel() }
  }

  deinit {
    listener.cancel()
    close()
  }
  var requestCount: Int { requests.value.withLock { $0.count } }
}

@Test(.timeLimit(.minutes(1)), .serialized, arguments: 0..<16)
func actualTransportAcceptsTheExactByteLimit(_ variant: Int) async throws {
  let body =
    variant % 2 == 0
    ? Data(repeating: 97, count: 8_388_608)
    : Data(
      (0..<8_388_608).map {
        UInt8(truncatingIfNeeded: ((UInt64($0) &+ UInt64(variant)) &* 0x9E37_79B9_7F4A_7C15) >> 56)
      })
  let server = try await HTTPTestServer { _ in
    httpResponse(body, headers: "Content-Length: \(body.count)\r\n")
  }
  let result = try await URLSessionTransport().send(
    URLRequest(url: server.origin.appendingPathComponent("api")))
  #expect(result.data.count == body.count)
  let equal = result.data == body
  if !equal {
    let mismatch = zip(result.data, body).enumerated().first { $0.element.0 != $0.element.1 }
    #expect(mismatch == nil, "First differing byte: \(String(describing: mismatch))")
  }
  #expect(equal, "Data equality disagreed; variant \(variant)")
}

@Test(.timeLimit(.minutes(1))) func cancellationBeforeAndDuringRealRequestsAlwaysCompletes()
  async throws
{
  let server = try await HTTPTestServer(finish: false) { _ in
    Data("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n[".utf8)
  }
  let request = URLRequest(url: server.origin.appendingPathComponent("api"))
  let cancelled = Task {
    withUnsafeCurrentTask { $0?.cancel() }
    return try await URLSessionTransport().send(request)
  }
  await #expect(throws: CancellationError.self) { try await cancelled.value }
  #expect(server.requestCount == 0)
  var received = server.received.makeAsyncIterator()
  let running = Task { try await URLSessionTransport().send(request) }
  _ = await received.next()
  running.cancel()
  await #expect(throws: CancellationError.self) { try await running.value }
  #expect(server.requestCount == 1)
  let api = try APIClient(origin: server.origin)
  let archive = try sampleArchive(bytes: 1000)
  let download = Task { try await api.download(archive) }
  _ = await received.next()
  download.cancel()
  await #expect(throws: CancellationError.self) { try await download.value }
  #expect(server.requestCount == 2)
}

func httpResponse(_ body: Data, headers: String = "") -> Data {
  Data(
    "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: application/json\r\n\(headers)\r\n".utf8)
    + body
}

@Test(.timeLimit(.minutes(1))) func actualTransportRejectsOversizedBodiesWithoutContentLength()
  async throws
{
  let body = Data(repeating: 97, count: 8_388_609)
  let server = try await HTTPTestServer { _ in httpResponse(body) }
  let request = URLRequest(url: server.origin.appendingPathComponent("api"))
  await #expect(throws: (any Error).self) { try await URLSessionTransport().send(request) }
  #expect(server.requestCount == 1)
}

@Test(.timeLimit(.minutes(1))) func actualTransportRejectsDecompressedBodiesAboveTheLimit()
  async throws
{
  let body = try (Data(repeating: 97, count: 8_388_609) as NSData).compressed(using: .zlib) as Data
  let server = try await HTTPTestServer { _ in
    httpResponse(body, headers: "Content-Encoding: deflate\r\nContent-Length: \(body.count)\r\n")
  }
  await #expect(throws: (any Error).self) {
    try await URLSessionTransport().send(
      URLRequest(url: server.origin.appendingPathComponent("api")))
  }
}

@Test(.timeLimit(.minutes(1))) func neitherJSONNorExportRequestsFollowRedirects() async throws {
  let snapshot = try sampleSnapshot().rawValue
  let destination = try await HTTPTestServer { _ in
    httpResponse(
      Data("[]".utf8), headers: "X-Dataset-Snapshot: \(snapshot)\r\n")
  }
  let location =
    destination.origin.appendingPathComponent("api").absoluteString + "?snapshot=" + snapshot
  let redirect = try await HTTPTestServer { _ in
    Data(
      "HTTP/1.1 302 Found\r\nLocation: \(location)\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        .utf8)
  }
  let result = try await URLSessionTransport().send(
    URLRequest(url: redirect.origin.appendingPathComponent("api")))
  #expect(result.response.statusCode == 302)
  let api = try APIClient(origin: redirect.origin)
  await #expect(throws: (any Error).self) {
    let file = try await api.download(sampleArchive(bytes: 2))
    try FileManager.default.removeItem(at: file)
  }
  #expect(destination.requestCount == 0)
  #expect(redirect.requestCount == 2)
}

func sampleArchive(bytes: Int, digest: String? = nil) throws -> DatasetArchive {
  let snapshot = try sampleSnapshot()
  let sha256 = try SnapshotID(digest ?? snapshot.rawValue)
  return DatasetArchive(
    snapshot: snapshot, contacts: 0,
    link: "/api/datasets/\(snapshot.rawValue)/\(sha256.rawValue)/directory.tsv.br",
    sha256: sha256, bytes: bytes)
}

@Test(.timeLimit(.minutes(1)))
func datasetDownloadsRequireTheirSnapshotTypeLengthAndDigest() async throws {
  let snapshot = try sampleSnapshot().rawValue
  let body = Data("archive".utf8)
  let digest = SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
  func server(type: String = "application/octet-stream", identity: String = snapshot) async throws
    -> HTTPTestServer
  {
    try await HTTPTestServer { request in
      let accepted = request.lowercased().contains("accept: application/octet-stream")
      return Data(
        "HTTP/1.1 \(accepted ? "200 OK" : "406 Not Acceptable")\r\nContent-Type: \(type)\r\nX-Dataset-Snapshot: \(identity)\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
          .utf8) + body
    }
  }
  let valid = try await server()
  let file = try await APIClient(origin: valid.origin).download(
    sampleArchive(bytes: body.count, digest: digest))
  defer { try? FileManager.default.removeItem(at: file) }
  #expect(try Data(contentsOf: file) == body)
  let json = try await server(type: "application/json")
  let foreign = try await server(identity: String(repeating: "b", count: 64))
  for (target, archive) in [
    (valid, try sampleArchive(bytes: body.count)),
    (valid, try sampleArchive(bytes: body.count + 1, digest: digest)),
    (json, try sampleArchive(bytes: body.count, digest: digest)),
    (foreign, try sampleArchive(bytes: body.count, digest: digest)),
  ] {
    await #expect(throws: ServiceError.self) {
      try await APIClient(origin: target.origin).download(archive)
    }
  }
  #expect(json.requestCount == 1 && foreign.requestCount == 1)
}
