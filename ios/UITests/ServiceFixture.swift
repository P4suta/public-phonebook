import Foundation
import Network
import Synchronization

final class ServiceFixture: Sendable {
  enum Route: Sendable {
    case dataset

    func matches(_ target: String) -> Bool {
      guard let url = URLComponents(string: target) else { return false }
      switch self {
      case .dataset: return url.path.hasPrefix("/api/datasets/")
      }
    }
  }

  enum Fault: Sendable { case unavailable, incomplete }

  /// One proxied request: when it arrived after the fixture started and how it ended.
  private struct Exchange {
    let target: String
    let received: Duration
    var outcome: String?
  }

  private struct State {
    var next: (Route, Fault)?
    var injected = 0
    var exchanges: [Exchange] = []
    var connections: [NWConnection] = []
  }

  private final class Storage: Sendable {
    let value = Mutex(State())
  }

  private let listener: NWListener
  private let state = Storage()
  private let session: URLSession
  private let started = ContinuousClock.now
  let origin: String

  init() async throws {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    let listener = try NWListener(using: parameters)
    self.listener = listener
    // The default request deadline outlasts the app's own, so the app decides when a request fails.
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpShouldSetCookies = false
    let session = URLSession(configuration: configuration)
    self.session = session
    let state = state
    let started = started
    listener.newConnectionHandler = { connection in
      state.value.withLock { $0.connections.append(connection) }
      connection.start(queue: .global())
      Self.receive(connection, prefix: Data(), state: state, session: session, started: started)
    }
    let ready = Mutex<CheckedContinuation<Void, any Error>?>(nil)
    try await withCheckedThrowingContinuation { continuation in
      ready.withLock { $0 = continuation }
      listener.stateUpdateHandler = { event in
        let result: Result<Void, any Error>
        switch event {
        case .ready: result = .success(())
        case .failed(let error): result = .failure(error)
        default: return
        }
        ready.withLock { value in
          defer { value = nil }
          return value
        }?.resume(with: result)
      }
      listener.start(queue: .global())
    }
    guard let port = listener.port else { throw URLError(.cannotConnectToHost) }
    origin = "http://127.0.0.1:\(port.rawValue)"
  }

  func failNext(_ route: Route, with fault: Fault = .unavailable) {
    state.value.withLock { $0.next = (route, fault) }
  }

  var injected: Int { state.value.withLock { $0.injected } }
  var requests: [String] { state.value.withLock { $0.exchanges.map(\.target) } }

  /// Every request with its arrival time, upstream status or error, and upstream duration.
  var log: String {
    let exchanges = state.value.withLock { $0.exchanges }
    guard !exchanges.isEmpty else { return "The fixture received no requests." }
    return exchanges.map {
      "+\(Self.seconds($0.received)) GET \($0.target) -> \($0.outcome ?? "no response yet")"
    }.joined(separator: "\n")
  }

  private static func seconds(_ duration: Duration) -> String {
    duration.formatted(
      .units(allowed: [.seconds], width: .narrow, fractionalPart: .show(length: 3)))
  }

  private static func receive(
    _ connection: NWConnection, prefix: Data, state: Storage, session: URLSession,
    started: ContinuousClock.Instant
  ) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384 - prefix.count) {
      bytes, _, finished, error in
      let data = prefix + (bytes ?? Data())
      guard data.range(of: Data("\r\n\r\n".utf8)) != nil else {
        guard !finished, error == nil, data.count < 16_384 else {
          connection.cancel()
          return
        }
        receive(connection, prefix: data, state: state, session: session, started: started)
        return
      }
      let request = String(decoding: data, as: UTF8.self)
      guard let line = request.components(separatedBy: "\r\n").first else { return }
      let parts = line.split(separator: " ")
      guard parts.count == 3, parts[0] == "GET", parts[1].hasPrefix("/api"),
        let url = URL(string: "http://127.0.0.1:3100" + parts[1])
      else {
        connection.cancel()
        return
      }
      let target = String(parts[1])
      let received = ContinuousClock.now
      let (index, fault): (Int, Fault?) = state.value.withLock { value in
        value.exchanges.append(Exchange(target: target, received: started.duration(to: received)))
        let index = value.exchanges.count - 1
        guard let next = value.next, next.0.matches(target) else { return (index, nil) }
        value.next = nil
        value.injected += 1
        return (index, next.1)
      }
      let finish: @Sendable (String) -> Void = { outcome in
        state.value.withLock { $0.exchanges[index].outcome = outcome }
      }
      if let fault {
        finish("injected \(fault)")
        switch fault {
        case .unavailable:
          send(connection, status: 503, headers: ["Content-Type": "application/json"], body: Data())
        case .incomplete:
          connection.send(
            content: Data(
              "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1048576\r\nConnection: close\r\n\r\n["
                .utf8),
            completion: .contentProcessed { _ in })
        }
        return
      }
      var forwarded = URLRequest(url: url)
      if let host = request.components(separatedBy: "\r\n").first(where: {
        $0.lowercased().hasPrefix("host:")
      }) {
        forwarded.setValue(
          "http://" + host.dropFirst(5).trimmingCharacters(in: .whitespaces),
          forHTTPHeaderField: "X-Fixture-Origin")
      }
      if let accept = request.components(separatedBy: "\r\n").first(where: {
        $0.lowercased().hasPrefix("accept:")
      }) {
        forwarded.setValue(String(accept.dropFirst(7)), forHTTPHeaderField: "Accept")
      }
      session.dataTask(with: forwarded) { body, response, error in
        let upstream = Self.seconds(received.duration(to: .now))
        guard let response = response as? HTTPURLResponse, let body,
          body.count <= 67_108_864
        else {
          finish(
            "502 after \(upstream) upstream: \(error.map { "\($0)" } ?? "no complete response")")
          send(connection, status: 502, headers: [:], body: Data())
          return
        }
        finish("\(response.statusCode) with \(body.count) bytes after \(upstream) upstream")
        var headers: [String: String] = [:]
        for field in [
          "Content-Type", "X-Dataset-Snapshot", "Retry-After",
        ] {
          if let value = response.value(forHTTPHeaderField: field) { headers[field] = value }
        }
        send(connection, status: response.statusCode, headers: headers, body: body)
      }.resume()
    }
  }

  private static func send(
    _ connection: NWConnection, status: Int, headers: [String: String], body: Data
  ) {
    let fields = headers.sorted(by: { $0.key < $1.key }).map { "\($0.key): \($0.value)\r\n" }
      .joined()
    let head =
      "HTTP/1.1 \(status) Test\r\n\(fields)Content-Length: \(body.count)\r\nConnection: close\r\n\r\n"
    connection.send(
      content: Data(head.utf8) + body,
      completion: .contentProcessed { _ in connection.cancel() })
  }

  deinit {
    listener.cancel()
    session.invalidateAndCancel()
    for connection in state.value.withLock({ $0.connections }) { connection.cancel() }
  }
}
