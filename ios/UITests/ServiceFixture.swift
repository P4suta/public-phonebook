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

  enum Fault: Sendable {
    case unavailable, incomplete
    /// Holds the reply until the first `release()`, then sends the head with one byte, because URLSession reports a head only with body bytes.
    /// It sends the next `bytes` bytes `after` that, so the app measures one pace, and holds the rest until the second `release()`.
    case paced(bytes: Int, after: Duration)
    /// Sends the head and the first `bytes` bytes, holds the connection open, and closes it at the first `release()`.
    case stall(bytes: Int)
  }

  /// One proxied request: when it arrived after the fixture started, the range it asked for, and how it ended.
  private struct Exchange {
    let target: String
    let range: String?
    let received: Duration
    var outcome: String?
  }

  private struct State {
    var next: (Route, Fault)?
    var injected = 0
    var exchanges: [Exchange] = []
    var connections: [NWConnection] = []
    var releases = 0
    var closed = false
    var holds: [(point: Int, continuation: CheckedContinuation<Void, Never>)] = []
  }

  private final class Storage: Sendable {
    let value = Mutex(State())
  }

  /// The provider fixture on the port that the iOS gate passed to the test runner, or on the development port.
  private static let upstream: String = {
    let port =
      ProcessInfo.processInfo.environment["PHONEBOOK_FIXTURE_PORT"].flatMap { UInt16($0) } ?? 3_100
    return "http://127.0.0.1:\(port)"
  }()

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

  /// Moves an injected reply past its next hold, and counts a release that comes before the reply reaches that hold.
  func release() {
    let resumed = state.value.withLock { value in
      value.releases += 1
      let releases = value.releases
      let resumed = value.holds.filter { $0.point <= releases }.map(\.continuation)
      value.holds.removeAll { $0.point <= releases }
      return resumed
    }
    for continuation in resumed { continuation.resume() }
  }

  /// Waits until the fixture has counted `point` releases or has stopped.
  private static func hold(_ point: Int, state: Storage) async {
    await withCheckedContinuation { continuation in
      let passed = state.value.withLock { value in
        guard !value.closed, value.releases < point else { return true }
        value.holds.append((point, continuation))
        return false
      }
      if passed { continuation.resume() }
    }
  }

  var injected: Int { state.value.withLock { $0.injected } }
  var requests: [String] { state.value.withLock { $0.exchanges.map(\.target) } }
  /// The `Range` header of each request, or nil for a request without one.
  var ranges: [String?] { state.value.withLock { $0.exchanges.map(\.range) } }
  var outcomes: [String?] { state.value.withLock { $0.exchanges.map(\.outcome) } }

  /// Every request with its arrival time, range, upstream status or error, and upstream duration.
  var log: String {
    let exchanges = state.value.withLock { $0.exchanges }
    guard !exchanges.isEmpty else { return "The fixture received no requests." }
    return exchanges.map {
      "+\(Self.seconds($0.received)) GET \($0.target)\($0.range.map { " (\($0))" } ?? "") -> \($0.outcome ?? "no response yet")"
    }.joined(separator: "\n")
  }

  private static func seconds(_ duration: Duration) -> String {
    duration.formatted(
      .units(allowed: [.seconds], width: .narrow, fractionalPart: .show(length: 3)))
  }

  private static func header(_ name: String, in request: String) -> String? {
    request.components(separatedBy: "\r\n").first {
      $0.lowercased().hasPrefix(name.lowercased() + ":")
    }.map { String($0.dropFirst(name.count + 1)).trimmingCharacters(in: .whitespaces) }
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
        let url = URL(string: Self.upstream + parts[1])
      else {
        connection.cancel()
        return
      }
      let target = String(parts[1])
      let range = header("Range", in: request)
      let received = ContinuousClock.now
      let (index, fault): (Int, Fault?) = state.value.withLock { value in
        value.exchanges.append(
          Exchange(target: target, range: range, received: started.duration(to: received)))
        let index = value.exchanges.count - 1
        guard let next = value.next, next.0.matches(target) else { return (index, nil) }
        value.next = nil
        value.injected += 1
        return (index, next.1)
      }
      let finish: @Sendable (String) -> Void = { outcome in
        state.value.withLock { $0.exchanges[index].outcome = outcome }
      }
      let note: @Sendable (String) -> Void = { event in
        state.value.withLock { value in
          value.exchanges[index].outcome = [value.exchanges[index].outcome, event].compactMap { $0 }
            .joined(separator: "; ")
        }
      }
      switch fault {
      case .unavailable:
        finish("injected unavailable")
        send(connection, status: 503, headers: ["Content-Type": "application/json"], body: Data())
        return
      case .incomplete:
        finish("injected incomplete")
        connection.send(
          content: Data(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1048576\r\nConnection: close\r\n\r\n["
              .utf8),
          completion: .contentProcessed { _ in })
        return
      case .paced, .stall, nil: break
      }
      var forwarded = URLRequest(url: url)
      if let host = header("Host", in: request) {
        forwarded.setValue("http://" + host, forHTTPHeaderField: "X-Fixture-Origin")
      }
      for name in ["Accept", "Range", "If-Range"] {
        if let value = header(name, in: request) {
          forwarded.setValue(value, forHTTPHeaderField: name)
        }
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
        let shaped = fault.map { " shaped by \($0)" } ?? ""
        finish(
          "\(response.statusCode) with \(body.count) bytes after \(upstream) upstream\(shaped)")
        var headers: [String: String] = [:]
        for field in [
          "Content-Type", "X-Dataset-Snapshot", "Retry-After", "Content-Range", "Accept-Ranges",
          "ETag",
        ] {
          if let value = response.value(forHTTPHeaderField: field) { headers[field] = value }
        }
        switch fault {
        case .paced(let bytes, let after):
          Task {
            let waiting = ContinuousClock.now
            await hold(1, state: state)
            note("held the reply \(seconds(waiting.duration(to: .now))) until release 1")
            connection.send(
              content: head(status: response.statusCode, headers: headers, length: body.count)
                + body.prefix(1),
              completion: .contentProcessed { _ in })
            try? await Task.sleep(for: after)
            let rest = body.dropFirst(1 + bytes)
            connection.send(
              content: body.dropFirst(1).prefix(bytes), completion: .contentProcessed { _ in })
            let measured = ContinuousClock.now
            await hold(2, state: state)
            note(
              "held the last \(rest.count) bytes \(seconds(measured.duration(to: .now))) until release 2"
            )
            connection.send(
              content: rest, completion: .contentProcessed { _ in connection.cancel() })
          }
        case .stall(let bytes):
          Task {
            connection.send(
              content: head(status: response.statusCode, headers: headers, length: body.count)
                + body.prefix(bytes),
              completion: .contentProcessed { _ in })
            let stalled = ContinuousClock.now
            await hold(1, state: state)
            note("held the connection \(seconds(stalled.duration(to: .now))) until release 1")
            connection.cancel()
          }
        default:
          send(connection, status: response.statusCode, headers: headers, body: body)
        }
      }.resume()
    }
  }

  private static func head(status: Int, headers: [String: String], length: Int) -> Data {
    let fields = headers.sorted(by: { $0.key < $1.key }).map { "\($0.key): \($0.value)\r\n" }
      .joined()
    return Data(
      "HTTP/1.1 \(status) Test\r\n\(fields)Content-Length: \(length)\r\nConnection: close\r\n\r\n"
        .utf8)
  }

  private static func send(
    _ connection: NWConnection, status: Int, headers: [String: String], body: Data
  ) {
    connection.send(
      content: head(status: status, headers: headers, length: body.count) + body,
      completion: .contentProcessed { _ in connection.cancel() })
  }

  deinit {
    listener.cancel()
    session.invalidateAndCancel()
    let (connections, holds) = state.value.withLock { value in
      value.closed = true
      defer { value.holds = [] }
      return (value.connections, value.holds.map(\.continuation))
    }
    for continuation in holds { continuation.resume() }
    for connection in connections { connection.cancel() }
  }
}
