import CryptoKit
import Foundation
import PhonebookCore

public enum ServiceError: Error, Equatable, Sendable {
  case invalidURL, invalidResponse, notFound, snapshotChanged
  /// The listing offers no directory archive in a format that this app reads, so the app needs an update.
  case unsupportedFormat
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

/// An immutable dataset download with the length and SHA-256 that its listing names.
public protocol DatasetFile: Sendable {
  var snapshot: SnapshotID { get }
  var link: String { get }
  var sha256: SnapshotID { get }
  var bytes: Int { get }
}

/// A listed delta that rebuilds the archive of `snapshot` from the saved snapshot `base`.
public struct DatasetDelta: DatasetFile, Equatable {
  /// Over ten times the decoded national archive, so a listing can't size an unbounded decoder.
  static let maximumDecodedBytes = 1_073_741_824
  /// The listed format of the deltas that this app applies, which `DirectoryDelta.swift` reads.
  static let format = "public-phonebook-directory-delta/1"

  public let snapshot: SnapshotID
  public let archiveSha256: SnapshotID
  public let base: SnapshotID
  public let link: String
  public let sha256: SnapshotID
  public let bytes: Int
  public let decodedBytes: Int

  static func file(base: SnapshotID) -> String { "directory-delta-\(base.rawValue).tsv.br" }
}

public struct DatasetArchive: DatasetFile, Equatable {
  /// The listed format of the archive that this app imports, which `DirectoryArchive.swift` reads.
  static let format = "public-phonebook-directory/1"
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

/// The current archive that this app imports, and the pinned delta listing of the same snapshot.
public struct DatasetListing: Sendable {
  public let archive: DatasetArchive
  /// The delta listing, which a provider that doesn't publish deltas omits.
  public let deltas: String?
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

  public func get(_ link: String, paths: NetworkPaths = .every) async throws -> HTTPResult {
    let operation = TraceContext.operation ?? UUID()
    trace.record(TraceEvent(operation: operation, phase: .request, outcome: .started))
    do {
      try Task.checkCancellation()
      try await retryWindow.check(at: now())
      var request = URLRequest(url: try resolve(link))
      request.timeoutInterval = 30
      request.setValue("application/json", forHTTPHeaderField: "Accept")
      paths.apply(to: &request)
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
    guard response.value(forHTTPHeaderField: "X-Dataset-Snapshot") == snapshot.rawValue else {
      throw ServiceError.invalidResponse
    }
    if let url = response.url {
      let items = URLComponents(url: url, resolvingAgainstBaseURL: true)?.queryItems ?? []
      if items.contains(where: { $0.name == "snapshot" }) {
        try validateLink(url.absoluteString, snapshot: snapshot)
      }
    }
  }

  /// Reads the dataset listing and picks the one archive in the format that this app imports.
  public func datasets(paths: NetworkPaths = .every) async throws -> DatasetListing {
    let response = try await get("/api/datasets", paths: paths)
    let listing = try JSONDecoder().decode(DirectoryDatasets.self, from: response.data)
    try validateIdentity(listing.snapshot, response: response.response)
    if let deltas = listing.datasetDeltas {
      try validateLink(deltas, snapshot: listing.snapshot)
    }
    let archives = listing.files.compactMap(\.entry)
    guard let file = archives.first else { throw ServiceError.unsupportedFormat }
    guard archives.count == 1, (0...5_000_000).contains(listing.contacts),
      (1...DatasetArchive.maximumBytes).contains(file.bytes),
      file.url == Self.datasetPath(listing.snapshot, file.sha256, file.file)
    else { throw ServiceError.invalidResponse }
    return DatasetListing(
      archive: DatasetArchive(
        snapshot: listing.snapshot, contacts: listing.contacts, link: file.url,
        sha256: file.sha256, bytes: file.bytes),
      deltas: listing.datasetDeltas)
  }

  /// Lists the deltas in this app's format to the current archive, each bound to its base, file name, and immutable URL.
  public func directoryDeltas(link: String, paths: NetworkPaths = .every) async throws
    -> [DatasetDelta]
  {
    let response = try await get(link, paths: paths)
    let listing = try JSONDecoder().decode(DirectoryDeltaListing.self, from: response.data)
    try validateIdentity(listing.snapshot, response: response.response)
    try validateLink(link, snapshot: listing.snapshot)
    return try listing.deltas.compactMap(\.entry).map { delta in
      let file = DatasetDelta.file(base: delta.base)
      guard delta.file == file, delta.base != listing.snapshot,
        (1...DatasetArchive.maximumBytes).contains(delta.bytes),
        (1...DatasetDelta.maximumDecodedBytes).contains(delta.uncompressedBytes),
        delta.url == Self.datasetPath(listing.snapshot, delta.sha256, file)
      else { throw ServiceError.invalidResponse }
      return DatasetDelta(
        snapshot: listing.snapshot, archiveSha256: listing.archiveSha256, base: delta.base,
        link: delta.url, sha256: delta.sha256, bytes: delta.bytes,
        decodedBytes: delta.uncompressedBytes)
    }
  }

  private static func datasetPath(_ snapshot: SnapshotID, _ sha256: SnapshotID, _ file: String)
    -> String
  {
    "/api/datasets/\(snapshot.rawValue)/\(sha256.rawValue)/\(file)"
  }

  /// Downloads a dataset file into `partials`, keeps the received bytes after a failure, and resumes them with a Range request.
  /// The returned file passed the listed length and SHA-256 over all its bytes, and the caller removes it once it no longer needs it.
  /// Without `partials`, the download starts in a new temporary directory and resumes nothing.
  public func download(
    _ archive: some DatasetFile, paths: NetworkPaths = .every, partials: URL? = nil,
    progress: @escaping @Sendable (TransferProgress) -> Void = { _ in }
  ) async throws -> URL {
    let operation = TraceContext.operation ?? UUID()
    trace.record(TraceEvent(operation: operation, phase: .download, outcome: .started))
    do {
      try Task.checkCancellation()
      try await retryWindow.check(at: now())
      let requested = try resolve(archive.link)
      guard requested.query == nil, requested.path == archive.link else {
        throw ServiceError.invalidResponse
      }
      let directory =
        partials
        ?? FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let lock = try TransferLock(url: directory.appendingPathComponent(TransferLock.name))
      defer { lock.release() }
      let partial = directory.appendingPathComponent(
        "\(archive.snapshot.rawValue)-\(archive.sha256.rawValue).partial")
      // A changed snapshot or digest names a different file, so the bytes of every other file go.
      for item in try FileManager.default.contentsOfDirectory(
        at: directory, includingPropertiesForKeys: nil)
      where item.lastPathComponent != partial.lastPathComponent
        && item.lastPathComponent != TransferLock.name
      {
        try FileManager.default.removeItem(at: item)
      }
      if !FileManager.default.fileExists(atPath: partial.path) {
        try Data().write(to: partial, options: .withoutOverwriting)
      }
      var offset = try Self.size(of: partial)
      if offset >= archive.bytes {
        if offset == archive.bytes,
          try DatasetArchive.digest(of: partial) == archive.sha256.rawValue
        {
          progress(TransferProgress(resumed: offset, received: 0, total: archive.bytes))
          trace.record(TraceEvent(operation: operation, phase: .download, outcome: .completed))
          return partial
        }
        try Data().write(to: partial)
        offset = 0
      }
      var request = URLRequest(url: requested)
      request.setValue(DatasetArchive.mimeType, forHTTPHeaderField: "Accept")
      if offset > 0 { request.setValue("bytes=\(offset)-", forHTTPHeaderField: "Range") }
      paths.apply(to: &request)
      let transfer = DatasetTransfer(
        partial: partial, offset: offset, expected: archive.bytes, snapshot: archive.snapshot,
        progress: progress)
      if let response = try await transfer.run(request) {
        if response.statusCode == 416 { try Data().write(to: partial) }
        try await checkResponse(response)
        throw ServiceError.http(response.statusCode)
      }
      try Task.checkCancellation()
      guard try Self.size(of: partial) == archive.bytes else { throw ServiceError.invalidResponse }
      guard try DatasetArchive.digest(of: partial) == archive.sha256.rawValue else {
        try Data().write(to: partial)
        throw ServiceError.invalidResponse
      }
      trace.record(TraceEvent(operation: operation, phase: .download, outcome: .completed))
      return partial
    } catch {
      let failure: any Error = Task.isCancelled ? CancellationError() : error
      trace.record(
        TraceEvent(
          operation: operation, phase: .download,
          outcome: failure is CancellationError ? .cancelled : .rejected))
      throw failure
    }
  }

  /// Reads the size from the open file each time, because a URL caches its resource values and file attributes need a declared reason.
  private static func size(of url: URL) throws -> Int {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    return Int(try handle.seekToEnd())
  }
}

/// Holds an exclusive advisory lock on one transfer directory, so two downloads never write the same partial file.
private final class TransferLock: Sendable {
  static let name = "transfer.lock"
  private let descriptor: Int32

  init(url: URL) throws {
    let descriptor = open(url.path, O_CREAT | O_RDWR | O_CLOEXEC, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw ImportError.unavailableStorage }
    guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
      close(descriptor)
      throw ImportError.alreadyUpdating
    }
    self.descriptor = descriptor
  }

  func release() {
    flock(descriptor, LOCK_UN)
    close(descriptor)
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
