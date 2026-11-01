import Foundation
import PhonebookCore
import Synchronization

public struct URLSessionTransport: HTTPTransport {
  public init() {}

  public func send(_ request: URLRequest) async throws -> HTTPResult {
    try await JSONTransfer().send(request)
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

  func send(_ request: URLRequest) async throws -> HTTPResult {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpShouldSetCookies = false
    configuration.httpCookieStorage = nil
    configuration.urlCredentialStorage = nil
    configuration.timeoutIntervalForRequest = 30
    configuration.timeoutIntervalForResource = 60
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        let task = session.dataTask(with: request)
        let cancelled = state.withLock {
          $0.continuation = continuation
          $0.task = task
          return $0.cancelled
        }
        if cancelled { finish(CancellationError()) } else { task.resume() }
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
