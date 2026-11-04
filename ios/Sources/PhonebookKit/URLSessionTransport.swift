import Foundation
import PhonebookCore
import Synchronization

/// Sends every JSON request of one client through one ephemeral session, so the requests share its connections.
public struct URLSessionTransport: HTTPTransport {
  let owned = OwnedSession(OwnedSession.json())

  public init() {}

  public func send(_ request: URLRequest) async throws -> HTTPResult {
    try await JSONTransfer().send(request, in: owned.session)
  }
}

/// One ephemeral session that its last owner invalidates, which cancels any task still running.
/// Each task carries its own delegate, so the session retains no delegate and its owner can go away.
final class OwnedSession: Sendable {
  let session: URLSession

  init(_ configuration: URLSessionConfiguration) {
    session = URLSession(configuration: configuration)
  }

  deinit { session.invalidateAndCancel() }

  /// JSON requests fail at once without a connection, so the listing and its retries keep their timing.
  static func json() -> URLSessionConfiguration {
    let configuration = base()
    configuration.timeoutIntervalForRequest = 30
    configuration.timeoutIntervalForResource = 60
    return configuration
  }

  /// A transfer waits for a connection, and the resource timeout bounds that wait with the transfer.
  static func transfers() -> URLSessionConfiguration {
    let configuration = base()
    configuration.waitsForConnectivity = true
    configuration.timeoutIntervalForResource = 900
    configuration.timeoutIntervalForRequest = 30
    return configuration
  }

  private static func base() -> URLSessionConfiguration {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpShouldSetCookies = false
    configuration.httpCookieStorage = nil
    configuration.urlCredentialStorage = nil
    return configuration
  }
}

private struct TransferState {
  var continuation: CheckedContinuation<HTTPResult, any Error>?
  var task: URLSessionDataTask?
  var response: HTTPURLResponse?
  var data = Data()
  var finished = false
  var cancelled = false
}

private final class JSONTransfer: NSObject, URLSessionDataDelegate {
  private let state = Mutex(TransferState())
  private let maximumBytes = 8_388_608

  func send(_ request: URLRequest, in session: URLSession) async throws -> HTTPResult {
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        let task = session.dataTask(with: request)
        task.delegate = self
        let cancelled = state.withLock {
          $0.continuation = continuation
          $0.task = task
          return $0.cancelled
        }
        // The shared session outlives this request, so a task that never starts must still end.
        if cancelled {
          task.cancel()
          finish(CancellationError())
        } else {
          task.resume()
        }
      }
    } onCancel: {
      let task = self.state.withLock {
        $0.cancelled = true
        return $0.task
      }
      task?.cancel()
      self.finish(CancellationError())
    }
  }

  private func finish(_ error: (any Error)? = nil) {
    let completion = state.withLock {
      value -> (
        CheckedContinuation<HTTPResult, any Error>, Result<HTTPResult, any Error>
      )? in
      guard !value.finished, let continuation = value.continuation else { return nil }
      value.finished = true
      value.continuation = nil
      value.task = nil
      if let error { return (continuation, .failure(error)) }
      guard let response = value.response else {
        return (continuation, .failure(ServiceError.invalidResponse))
      }
      return (continuation, .success(HTTPResult(data: value.data, response: response)))
    }
    if let (continuation, result) = completion { continuation.resume(with: result) }
  }

  func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
  ) {
    guard let response = response as? HTTPURLResponse,
      response.expectedContentLength <= Int64(maximumBytes)
    else {
      finish(ServiceError.invalidResponse)
      completionHandler(.cancel)
      return
    }
    state.withLock { $0.response = response }
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    let admitted = state.withLock {
      guard !$0.finished else { return true }
      guard ReceiveBudget.admits(used: $0.data.count, incoming: data.count, limit: maximumBytes)
      else { return false }
      $0.data.append(data)
      return true
    }
    if !admitted {
      finish(ServiceError.invalidResponse)
      dataTask.cancel()
    }
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?
  ) { finish(error) }

  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) { completionHandler(nil) }
}
