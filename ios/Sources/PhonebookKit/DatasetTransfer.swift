import Foundation
import PhonebookCore
import Synchronization

/// Which network paths a request may use.
public enum NetworkPaths: Sendable, Equatable {
  /// Every path, including mobile data and Low Data Mode, for the first download that the person started.
  case every
  /// Only paths that are neither expensive nor constrained, for the automatic monthly update.
  case inexpensive

  func apply(to request: inout URLRequest) {
    request.allowsExpensiveNetworkAccess = self == .every
    request.allowsConstrainedNetworkAccess = self == .every
  }
}

/// The bytes of one dataset file: those kept from earlier attempts, those received in this attempt, and the listed length.
public struct TransferProgress: Sendable, Equatable {
  public let resumed: Int
  public let received: Int
  public let total: Int
  /// The transfer waits for a network connection, and the next received bytes end the wait.
  public let waiting: Bool

  public init(resumed: Int, received: Int, total: Int, waiting: Bool = false) {
    self.resumed = resumed
    self.received = received
    self.total = total
    self.waiting = waiting
  }
}

private struct TransferState {
  var continuation: CheckedContinuation<HTTPURLResponse?, any Error>?
  var task: URLSessionDataTask?
  var handle: FileHandle?
  var response: HTTPURLResponse?
  var offset = 0
  var received = 0
  var failure: (any Error)?
  var finished = false
  var cancelled = false
}

/// Appends one response for a dataset file to its partial file, resuming after `offset` bytes with a Range request.
/// A 200 reply restarts the file, and a 206 reply must start at `offset` and end at the listed length.
final class DatasetTransfer: NSObject, URLSessionDataDelegate, Sendable {
  private let state = Mutex(TransferState())
  private let partial: URL
  private let expected: Int
  private let snapshot: SnapshotID
  private let progress: @Sendable (TransferProgress) -> Void

  init(
    partial: URL, offset: Int, expected: Int, snapshot: SnapshotID,
    progress: @escaping @Sendable (TransferProgress) -> Void
  ) {
    self.partial = partial
    self.expected = expected
    self.snapshot = snapshot
    self.progress = progress
    super.init()
    state.withLock { $0.offset = offset }
  }

  /// Sends the request in the client's transfer session and returns the final response, or nil when the reply restarted or resumed the file.
  func run(_ request: URLRequest, in session: URLSession) async throws -> HTTPURLResponse? {
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        let task = session.dataTask(with: request)
        task.delegate = self
        let cancelled = state.withLock {
          $0.continuation = continuation
          $0.task = task
          return $0.cancelled
        }
        // The shared session outlives this transfer, so a task that never starts must still end.
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

  var offset: Int { state.withLock { $0.offset } }

  private func finish(_ error: (any Error)? = nil) {
    let completion = state.withLock {
      value -> (
        CheckedContinuation<HTTPURLResponse?, any Error>, Result<HTTPURLResponse?, any Error>
      )?
      in
      guard !value.finished, let continuation = value.continuation else { return nil }
      value.finished = true
      value.continuation = nil
      value.task = nil
      try? value.handle?.close()
      value.handle = nil
      if let failure = value.failure ?? error { return (continuation, .failure(failure)) }
      return (continuation, .success(value.response))
    }
    if let (continuation, result) = completion { continuation.resume(with: result) }
  }

  /// Opens the partial file for a 200 or 206 reply, and keeps any other reply for the caller to judge.
  private func accept(_ response: HTTPURLResponse) throws -> Bool {
    guard response.statusCode == 200 || response.statusCode == 206 else { return false }
    guard response.value(forHTTPHeaderField: "X-Dataset-Snapshot") == snapshot.rawValue,
      response.mimeType == DatasetArchive.mimeType,
      response.value(forHTTPHeaderField: "Content-Encoding") == nil
    else { throw ServiceError.invalidResponse }
    let offset = state.withLock { $0.offset }
    let start: Int
    if response.statusCode == 206 {
      guard
        let range = ContentRange(response.value(forHTTPHeaderField: "Content-Range") ?? ""),
        range.first == offset, range.last == expected - 1, range.total == expected, offset > 0
      else { throw ServiceError.invalidResponse }
      start = offset
    } else {
      start = 0
    }
    let length = response.expectedContentLength
    guard length < 0 || length == Int64(expected - start) else {
      throw ServiceError.invalidResponse
    }
    let handle = try FileHandle(forUpdating: partial)
    do {
      try handle.truncate(atOffset: UInt64(start))
      try handle.seekToEnd()
    } catch {
      try? handle.close()
      throw error
    }
    state.withLock {
      $0.handle = handle
      $0.offset = start
      $0.response = nil
    }
    progress(TransferProgress(resumed: start, received: 0, total: expected))
    return true
  }

  func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
  ) {
    guard let response = response as? HTTPURLResponse else {
      state.withLock { $0.failure = ServiceError.invalidResponse }
      completionHandler(.cancel)
      return
    }
    do {
      if try accept(response) {
        completionHandler(.allow)
      } else {
        state.withLock { $0.response = response }
        completionHandler(.cancel)
        finish()
      }
    } catch {
      state.withLock { $0.failure = error }
      completionHandler(.cancel)
      finish()
    }
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    let written: Result<TransferProgress, any Error>? = state.withLock { value in
      guard !value.finished, let handle = value.handle else { return nil }
      guard
        ReceiveBudget.admits(
          used: value.offset + value.received, incoming: data.count, limit: expected)
      else { return .failure(ServiceError.invalidResponse) }
      do {
        try handle.write(contentsOf: data)
        value.received += data.count
        return .success(
          TransferProgress(resumed: value.offset, received: value.received, total: expected))
      } catch { return .failure(error) }
    }
    switch written {
    case .success(let report): progress(report)
    case .failure(let error):
      state.withLock { $0.failure = error }
      dataTask.cancel()
      finish()
    case nil: break
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

  /// Reports a transfer that waits for a connection, which the wait display shows at once.
  func urlSession(_ session: URLSession, taskIsWaitingForConnectivity task: URLSessionTask) {
    let report = state.withLock { value -> TransferProgress? in
      guard !value.finished else { return nil }
      return TransferProgress(
        resumed: value.offset, received: value.received, total: expected, waiting: true)
    }
    if let report { progress(report) }
  }
}

/// The `bytes first-last/total` value of a single-range `Content-Range` header.
struct ContentRange: Equatable {
  let first: Int
  let last: Int
  let total: Int

  init?(_ header: String) {
    guard header.hasPrefix("bytes ") else { return nil }
    let parts = header.dropFirst(6).split(separator: "/", omittingEmptySubsequences: false)
    guard parts.count == 2 else { return nil }
    let bounds = parts[0].split(separator: "-", omittingEmptySubsequences: false)
    guard bounds.count == 2, let first = Self.number(bounds[0]), let last = Self.number(bounds[1]),
      let total = Self.number(parts[1]), first <= last, last < total
    else { return nil }
    self.first = first
    self.last = last
    self.total = total
  }

  private static func number(_ text: Substring) -> Int? {
    guard !text.isEmpty, text.count <= 18, text.allSatisfy({ $0.isASCII && $0.isNumber }) else {
      return nil
    }
    return Int(text)
  }
}
