import Foundation
import Network
import Synchronization

final class ServiceFixture: Sendable {
  enum Route: Sendable {
    case dataset

    func matches(_ target: String) -> Bool {
      guard let url = URLComponents(string: target) else { return false }
      switch self {
      case .dataset: return url.path.hasPrefix("/api/v1/datasets/")
      }
    }
  }

  enum Fault: Sendable { case unavailable, incomplete }

  private struct State {
    var next: (Route, Fault)?
    var injected = 0
    var requests: [String] = []
    var connections: [NWConnection] = []
  }

  private final class Storage: Sendable {
    let value = Mutex(State())
  }

  private let listener: NWListener
  private let state = Storage()
  private let session: URLSession
  let origin: String

  init() async throws {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    let listener = try NWListener(using: parameters)
    self.listener = listener
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 15
    configuration.httpShouldSetCookies = false
    let session = URLSession(configuration: configuration)
    self.session = session
    let state = state
    listener.newConnectionHandler = { connection in
      state.value.withLock { $0.connections.append(connection) }
      connection.start(queue: .global())
      Self.receive(connection, prefix: Data(), state: state, session: session)
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
  var requests: [String] { state.value.withLock { $0.requests } }

  private static func receive(
    _ connection: NWConnection, prefix: Data, state: Storage, session: URLSession
  ) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384 - prefix.count) {
      bytes, _, finished, error in
      let data = prefix + (bytes ?? Data())
      guard data.range(of: Data("\r\n\r\n".utf8)) != nil else {
        guard !finished, error == nil, data.count < 16_384 else {
          connection.cancel()
          return
        }
        receive(connection, prefix: data, state: state, session: session)
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
      let fault: Fault? = state.value.withLock { value in
        value.requests.append(target)
        guard let next = value.next, next.0.matches(target) else { return nil }
        value.next = nil
        value.injected += 1
        return next.1
      }
      if let fault {
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
      session.dataTask(with: forwarded) { body, response, _ in
        guard let response = response as? HTTPURLResponse, let body,
          body.count <= 67_108_864
        else {
          send(connection, status: 502, headers: [:], body: Data())
          return
        }
        var headers: [String: String] = [:]
        for field in [
          "Content-Type", "X-Dataset-Snapshot", "X-Directory-API-Version", "Retry-After",
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
