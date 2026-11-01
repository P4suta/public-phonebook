import CryptoKit
import Foundation
import PhonebookCore

public enum ServiceError: Error, Sendable {
  case invalidURL, invalidResponse, notFound, snapshotChanged
  case unavailable(retryAfter: Date?)
  case http(Int)
}

public struct HTTPResult: Sendable {
  public let data: Data
  public let response: HTTPURLResponse
  public init(data: Data, response: HTTPURLResponse) {
    self.data = data
    self.response = response
  }
}

public struct DatasetArchive: Equatable, Sendable {
  static let file = "directory.tsv.br"
  static let mimeType = "application/octet-stream"
  static let maximumBytes = 268_435_456

  public let snapshot: SnapshotID
  public let contacts: Int
  public let link: String
  public let sha256: SnapshotID
  public let bytes: Int

  static func digest(of url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hasher = SHA256()
    while let chunk = try handle.read(upToCount: 1_048_576), !chunk.isEmpty {
      hasher.update(data: chunk)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }
}

public protocol HTTPTransport: Sendable {
  func send(_ request: URLRequest) async throws -> HTTPResult
}

public struct APIClient: Sendable {
  public let origin: URL
  private let transport: any HTTPTransport
  private let now: @Sendable () -> Date
  private let trace: any TraceSink
  private let retryWindow = RetryWindow()

  public init(
    origin: URL, transport: any HTTPTransport = URLSessionTransport(),
    now: @escaping @Sendable () -> Date = Date.init, trace: any TraceSink = DiscardingTraceSink()
  ) throws {
    guard origin.user == nil, origin.password == nil, origin.query == nil, origin.fragment == nil,
      origin.host?.isEmpty == false, origin.path.isEmpty || origin.path == "/",
      origin.scheme == "https"
        || (origin.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(origin.host))
    else { throw ServiceError.invalidURL }
    self.origin = origin
    self.transport = transport
    self.now = now
    self.trace = trace
  }

  public func resolve(_ link: String) throws -> URL {
    guard let url = URL(string: link, relativeTo: origin)?.absoluteURL.standardized,
      url.scheme == origin.scheme, url.host == origin.host, url.port == origin.port,
      url.user == nil, url.password == nil, url.fragment == nil,
      !url.path.split(separator: "/").contains(".."),
      url.path == "/api" || url.path.hasPrefix("/api/")
    else { throw ServiceError.invalidURL }
    return url
  }

  public func validateLink(_ link: String, snapshot: SnapshotID) throws {
    let url = try resolve(link)
    let items = URLComponents(url: url, resolvingAgainstBaseURL: true)?.queryItems ?? []
    let identities = items.filter { $0.name == "snapshot" }
    guard identities.count == 1, identities.first?.value == snapshot.rawValue else {
      throw ServiceError.snapshotChanged
    }
  }

  public func discovery() async throws -> Resource<Endpoints> {
    let response = try await get("/api/v1")
    let result = try JSONDecoder().decode(DirectoryDiscovery.self, from: response.data).resource()
    try validateIdentity(result.meta.snapshot, response: response.response)
    try validateLink(result.data.datasets, snapshot: result.meta.snapshot)
    return result
  }

  public func get(_ link: String) async throws -> HTTPResult {
    let operation = TraceContext.operation ?? UUID()
    trace.record(TraceEvent(operation: operation, phase: .request, outcome: .started))
    do {
      try Task.checkCancellation()
      try await retryWindow.check(at: now())
      var request = URLRequest(url: try resolve(link))
      request.timeoutInterval = 30
      request.setValue("application/json", forHTTPHeaderField: "Accept")
      let result = try await transport.send(request)
      try Task.checkCancellation()
      try await checkResponse(result.response)
      guard result.data.count <= 8_388_608, result.response.mimeType == "application/json" else {
        throw ServiceError.invalidResponse
      }
      trace.record(TraceEvent(operation: operation, phase: .request, outcome: .completed))
      return result
    } catch {
      trace.record(
        TraceEvent(
          operation: operation, phase: .request,
          outcome: error is CancellationError ? .cancelled : .rejected))
      throw error
    }
  }

  public func validateResponse(_ response: HTTPURLResponse) throws {
    guard let url = response.url, try resolve(url.absoluteString) == url else {
      throw ServiceError.invalidResponse
    }
    switch response.statusCode {
    case 200: break
    case 404: throw ServiceError.notFound
    case 409: throw ServiceError.snapshotChanged
    case 429, 503:
      let header = response.value(forHTTPHeaderField: "Retry-After")
      let date: Date?
      if let header, let delay = TimeInterval(header), delay >= 0, delay.isFinite {
        date = now().addingTimeInterval(min(delay, 86_400))
      } else if let header {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        date = formatter.date(from: header).map {
          max(now(), min($0, now().addingTimeInterval(86_400)))
        }
      } else {
        date = nil
      }
      throw ServiceError.unavailable(retryAfter: date)
    default: throw ServiceError.http(response.statusCode)
    }
  }

  private func checkResponse(_ response: HTTPURLResponse) async throws {
    do { try validateResponse(response) } catch ServiceError.unavailable(let date) {
      await retryWindow.record(date)
      throw ServiceError.unavailable(retryAfter: date)
    }
  }

  public func validateIdentity(_ snapshot: SnapshotID, response: HTTPURLResponse) throws {
    guard response.value(forHTTPHeaderField: "X-Dataset-Snapshot") == snapshot.rawValue,
      response.value(forHTTPHeaderField: "X-Directory-API-Version") == "1"
    else { throw ServiceError.invalidResponse }
    if let url = response.url {
      let items = URLComponents(url: url, resolvingAgainstBaseURL: true)?.queryItems ?? []
      if items.contains(where: { $0.name == "snapshot" }) {
        try validateLink(url.absoluteString, snapshot: snapshot)
      }
    }
  }

  public func directoryArchive(link: String) async throws -> DatasetArchive {
    let response = try await get(link)
    let manifest = try JSONDecoder().decode(DirectoryDatasets.self, from: response.data)
    try validateIdentity(manifest.snapshot, response: response.response)
    try validateLink(link, snapshot: manifest.snapshot)
    let files = manifest.files.filter { $0.file == DatasetArchive.file }
    guard files.count == 1, let file = files.first, (0...5_000_000).contains(manifest.contacts),
      (1...DatasetArchive.maximumBytes).contains(file.bytes),
      file.url
        == "/api/v1/datasets/\(manifest.snapshot.rawValue)/\(file.sha256.rawValue)/\(file.file)"
    else { throw ServiceError.invalidResponse }
    return DatasetArchive(
      snapshot: manifest.snapshot, contacts: manifest.contacts, link: file.url,
      sha256: file.sha256, bytes: file.bytes)
  }

  public func download(
    _ archive: DatasetArchive, progress: @escaping @Sendable (Double) -> Void = { _ in }
  ) async throws -> URL {
    let operation = TraceContext.operation ?? UUID()
    trace.record(TraceEvent(operation: operation, phase: .download, outcome: .started))
    do {
      try Task.checkCancellation()
      try await retryWindow.check(at: now())
      let configuration = URLSessionConfiguration.ephemeral
      configuration.httpShouldSetCookies = false
      configuration.httpCookieStorage = nil
      configuration.urlCredentialStorage = nil
      configuration.timeoutIntervalForResource = 900
      configuration.timeoutIntervalForRequest = 30
      let observer = DownloadObserver(expected: archive.bytes, progress: progress)
      let session = URLSession(configuration: configuration, delegate: observer, delegateQueue: nil)
      defer { session.finishTasksAndInvalidate() }
      let requested = try resolve(archive.link)
      guard requested.query == nil, requested.path == archive.link else {
        throw ServiceError.invalidResponse
      }
      var request = URLRequest(url: requested)
      request.setValue(DatasetArchive.mimeType, forHTTPHeaderField: "Accept")
      let (temporary, response) = try await session.download(for: request, delegate: observer)
      do {
        guard let response = response as? HTTPURLResponse else {
          throw ServiceError.invalidResponse
        }
        try await checkResponse(response)
        try Task.checkCancellation()
        let size = try temporary.resourceValues(forKeys: [.fileSizeKey]).fileSize
        guard response.value(forHTTPHeaderField: "X-Dataset-Snapshot") == archive.snapshot.rawValue,
          response.mimeType == DatasetArchive.mimeType,
          response.value(forHTTPHeaderField: "Content-Encoding") == nil, size == archive.bytes,
          try DatasetArchive.digest(of: temporary) == archive.sha256.rawValue
        else { throw ServiceError.invalidResponse }
        let retained = FileManager.default.temporaryDirectory.appendingPathComponent(
          UUID().uuidString)
        try FileManager.default.moveItem(at: temporary, to: retained)
        trace.record(TraceEvent(operation: operation, phase: .download, outcome: .completed))
        return retained
      } catch {
        try? FileManager.default.removeItem(at: temporary)
        throw error
      }
    } catch {
      let failure: any Error = Task.isCancelled ? CancellationError() : error
      trace.record(
        TraceEvent(
          operation: operation, phase: .download,
          outcome: failure is CancellationError ? .cancelled : .rejected))
      throw failure
    }
  }
}

private actor RetryWindow {
  private var earliest: Date?

  func check(at date: Date) throws {
    if let earliest, earliest > date { throw ServiceError.unavailable(retryAfter: earliest) }
  }

  func record(_ date: Date?) {
    if let date { earliest = max(earliest ?? date, date) }
  }
}

private final class DownloadObserver: NSObject, URLSessionDownloadDelegate, Sendable {
  private let expected: Int
  private let progress: @Sendable (Double) -> Void

  init(expected: Int, progress: @escaping @Sendable (Double) -> Void) {
    self.expected = expected
    self.progress = progress
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) { completionHandler(nil) }

  func urlSession(
    _ session: URLSession, downloadTask: URLSessionDownloadTask,
    didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64
  ) {
    if totalBytesWritten > expected || totalBytesExpectedToWrite > expected {
      downloadTask.cancel()
      return
    }
    progress(Double(totalBytesWritten) / Double(max(expected, 1)))
  }

  func urlSession(
    _ session: URLSession, downloadTask: URLSessionDownloadTask,
    didFinishDownloadingTo location: URL
  ) {}
}
