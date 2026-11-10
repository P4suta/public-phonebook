import Darwin
import Foundation
import Synchronization
import Testing

@testable import PhonebookKit

private actor StubTransport: HTTPTransport {
  let result: HTTPResult
  init(_ result: HTTPResult) { self.result = result }
  func send(_ request: URLRequest) async throws -> HTTPResult { result }
}

@Test func apiRefusesForeignOriginsCredentialsAndPathEscapes() throws {
  let origin = try #require(URL(string: "https://dial.page"))
  let api = try APIClient(origin: origin)
  for link in [
    "https://evil.example/api", "//evil.example/api", "https://name@dial.page/api",
    "/other", "/api/../private", "javascript:alert(1)",
  ] {
    #expect(throws: ServiceError.self) { try api.resolve(link) }
  }
}

/// Answers every request with `data` as the JSON at `path`, under the snapshot header `identity`.
private func stubbedClient(_ data: Data, path: String, identity: String) throws -> APIClient {
  let origin = try #require(URL(string: "https://dial.page"))
  let response = try #require(
    HTTPURLResponse(
      url: origin.appendingPathComponent(path), statusCode: 200, httpVersion: nil,
      headerFields: ["Content-Type": "application/json", "X-Dataset-Snapshot": identity]))
  return try APIClient(
    origin: origin, transport: StubTransport(HTTPResult(data: data, response: response)))
}

/// A dataset listing whose files are the given JSON objects.
private func listing(_ snapshot: String, files: [String]) -> Data {
  Data(
    """
    {"snapshot":"\(snapshot)","generatedAt":"2026-10-30","contacts":1,\
    "files":[\(files.joined(separator: ","))]}
    """.utf8)
}

private func archiveEntry(_ snapshot: String, format: String = "public-phonebook-directory/1")
  -> String
{
  """
  {"file":"directory.tsv.br","format":"\(format)","sha256":"\(snapshot)","bytes":1,\
  "url":"/api/datasets/\(snapshot)/\(snapshot)/directory.tsv.br"}
  """
}

@Test func responseSnapshotMustMatchTheHeader() async throws {
  let snapshot = try sampleSnapshot().rawValue
  let api = try stubbedClient(
    listing(snapshot, files: [archiveEntry(snapshot)]), path: "api/datasets",
    identity: String(repeating: "b", count: 64))
  await #expect(throws: ServiceError.self) { try await api.datasets() }
}

@Test func theListingPicksTheArchiveInThisAppsFormatAndSkipsUnknownFormats() async throws {
  let snapshot = try sampleSnapshot().rawValue
  // A later format may list other fields, so the client must not decode it.
  let later = #"{"file":"directory.bin","format":"public-phonebook-directory/2"}"#
  let api = try stubbedClient(
    listing(snapshot, files: [later, archiveEntry(snapshot)]), path: "api/datasets",
    identity: snapshot)
  let current = try await api.datasets()
  #expect(current.archive.link == "/api/datasets/\(snapshot)/\(snapshot)/directory.tsv.br")
  #expect(current.archive.snapshot.rawValue == snapshot)
  #expect(current.deltas == nil)
}

@Test func aListingWithoutThisAppsFormatIsUnsupported() async throws {
  let snapshot = try sampleSnapshot().rawValue
  for files in [
    [archiveEntry(snapshot, format: "public-phonebook-directory/2")],
    [#"{"file":"contacts.csv.gz","format":"public-phonebook-contacts-csv/1"}"#], [],
  ] {
    let api = try stubbedClient(
      listing(snapshot, files: files), path: "api/datasets", identity: snapshot)
    await #expect(throws: ServiceError.unsupportedFormat) { try await api.datasets() }
  }
}

@Test func twoArchivesInThisAppsFormatAreAnInvalidListing() async throws {
  let snapshot = try sampleSnapshot().rawValue
  let api = try stubbedClient(
    listing(snapshot, files: [archiveEntry(snapshot), archiveEntry(snapshot)]),
    path: "api/datasets", identity: snapshot)
  await #expect(throws: ServiceError.invalidResponse) { try await api.datasets() }
}

@Test func snapshotConflictAndServiceRetryDelayHaveDistinctErrors() throws {
  let origin = try #require(URL(string: "https://dial.page"))
  let api = try APIClient(origin: origin)
  let url = origin.appendingPathComponent("api")
  let conflict = try #require(
    HTTPURLResponse(url: url, statusCode: 409, httpVersion: nil, headerFields: nil))
  #expect(throws: ServiceError.self) { try api.validateResponse(conflict) }
  for status in [429, 503] {
    let unavailable = try #require(
      HTTPURLResponse(
        url: url, statusCode: status,
        httpVersion: nil, headerFields: ["Retry-After": "120"]))
    do {
      try api.validateResponse(unavailable)
      Issue.record("The unavailable response succeeded")
    } catch ServiceError.unavailable(let retry) {
      #expect(retry != nil)
    }
  }
}

@Test func duplicateSnapshotParametersCannotBypassIdentityValidation() throws {
  let origin = try #require(URL(string: "https://dial.page"))
  let snapshot = try sampleSnapshot()
  let url = try #require(
    URL(
      string:
        "https://dial.page/api?snapshot=\(snapshot.rawValue)&snapshot=\(sampleSnapshot("b").rawValue)"
    ))
  let response = try #require(
    HTTPURLResponse(
      url: url, statusCode: 200, httpVersion: nil,
      headerFields: ["X-Dataset-Snapshot": snapshot.rawValue]))
  #expect(throws: ServiceError.self) {
    try APIClient(origin: origin).validateIdentity(snapshot, response: response)
  }
}

@Test func retryHTTPDatesCannotSuspendTheClientForMoreThanADay() throws {
  let now = Date(timeIntervalSince1970: 1000)
  let api = try APIClient(origin: #require(URL(string: "https://dial.page")), now: { now })
  let formatter = DateFormatter()
  formatter.locale = Locale(identifier: "en_US_POSIX")
  formatter.timeZone = TimeZone(secondsFromGMT: 0)
  formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
  let url = try #require(URL(string: "https://dial.page/api"))
  let response = try #require(
    HTTPURLResponse(
      url: url,
      statusCode: 503, httpVersion: nil,
      headerFields: ["Retry-After": formatter.string(from: now.addingTimeInterval(1_000_000))]))
  do {
    try api.validateResponse(response)
    Issue.record("A 503 succeeded")
  } catch ServiceError.unavailable(let date) {
    #expect(try #require(date) <= now.addingTimeInterval(86_400))
  }
}

@Test func serviceOriginsRequireAHostAndRootPath() throws {
  for origin in [
    "https:api", "https://dial.page/private", "https://dial.page?query",
    "https://dial.page#fragment", "ftp://localhost", "http://dial.page",
  ] {
    #expect(throws: ServiceError.self) { try APIClient(origin: #require(URL(string: origin))) }
  }
}

private struct InspectingTransport: HTTPTransport {
  let reply: @Sendable (URLRequest) throws -> HTTPResult
  func send(_ request: URLRequest) async throws -> HTTPResult { try reply(request) }
}

@Test func jsonRequestsKeepTheirHeadersPathPolicyByteBoundaryAndTrace() async throws {
  let origin = try #require(URL(string: "https://dial.page"))
  let body = Data(repeating: 0x20, count: 8_388_608)
  let response = try #require(
    HTTPURLResponse(
      url: origin.appendingPathComponent("api"), statusCode: 200, httpVersion: nil,
      headerFields: ["Content-Type": "application/json"]))
  let trace = RecordingTrace()
  let operation = UUID()
  let api = try APIClient(
    origin: origin,
    transport: InspectingTransport { request in
      #expect(request.value(forHTTPHeaderField: "Accept") == "application/json")
      #expect(!request.allowsExpensiveNetworkAccess && !request.allowsConstrainedNetworkAccess)
      return HTTPResult(data: body, response: response)
    }, trace: trace)
  let result = try await TraceContext.$operation.withValue(operation) {
    try await api.get("/api", paths: .inexpensive)
  }
  #expect(result.data == body)
  #expect(
    trace.events.withLock { $0 } == [
      TraceEvent(operation: operation, phase: .request, outcome: .started),
      TraceEvent(operation: operation, phase: .request, outcome: .completed),
    ])
}

@Test(arguments: [false, true])
func jsonFailuresCloseTheirTraceWithTheActualOutcome(cancelled: Bool) async throws {
  for conditional in [false, true] {
    let trace = RecordingTrace()
    let operation = UUID()
    let api = try APIClient(
      origin: #require(URL(string: "https://dial.page")),
      transport: InspectingTransport { _ in
        if cancelled { throw CancellationError() }
        throw ServiceError.invalidResponse
      }, trace: trace)
    await #expect(throws: (any Error).self) {
      try await TraceContext.$operation.withValue(operation) {
        if conditional {
          _ = try await api.datasets(etag: "saved")
        } else {
          _ = try await api.get("/api")
        }
      }
    }
    #expect(
      trace.events.withLock { $0 } == [
        TraceEvent(operation: operation, phase: .request, outcome: .started),
        TraceEvent(
          operation: operation, phase: .request, outcome: cancelled ? .cancelled : .rejected),
      ])
  }
}

@Test func conditionalListingsAcceptTheirExactByteLimitAndCloseNotModifiedTraces()
  async throws
{
  let snapshot = try sampleSnapshot().rawValue
  let compact = listing(snapshot, files: [archiveEntry(snapshot)])
  let body = compact + Data(repeating: 0x20, count: 8_388_608 - compact.count)
  let origin = try #require(URL(string: "https://dial.page"))
  for status in [200, 304] {
    let trace = RecordingTrace()
    let operation = UUID()
    let response = try #require(
      HTTPURLResponse(
        url: origin.appendingPathComponent("api/datasets"), statusCode: status, httpVersion: nil,
        headerFields: ["Content-Type": "application/json", "X-Dataset-Snapshot": snapshot]))
    let api = try APIClient(
      origin: origin,
      transport: InspectingTransport { request in
        #expect(request.value(forHTTPHeaderField: "Accept") == "application/json")
        #expect(request.value(forHTTPHeaderField: "If-None-Match") == "saved")
        #expect(!request.allowsExpensiveNetworkAccess && !request.allowsConstrainedNetworkAccess)
        return HTTPResult(data: body, response: response)
      }, trace: trace)
    let answer = try await TraceContext.$operation.withValue(operation) {
      try await api.datasets(paths: .inexpensive, etag: "saved")
    }
    switch answer {
    case .notModified: #expect(status == 304)
    case .listed(_, _, let saved): #expect(status == 200 && saved == body)
    }
    #expect(
      trace.events.withLock { $0 } == [
        TraceEvent(operation: operation, phase: .request, outcome: .started),
        TraceEvent(operation: operation, phase: .request, outcome: .completed),
      ])
  }
}

@Test func retryWindowBlocksUntilItsExactDeadlineWithoutSendingAnotherRequest() async throws {
  let origin = try #require(URL(string: "https://dial.page"))
  let date = Mutex(Date(timeIntervalSince1970: 1000))
  let requests = Mutex(0)
  let api = try APIClient(
    origin: origin,
    transport: InspectingTransport { request in
      let first = requests.withLock { value in
        defer { value += 1 }
        return value == 0
      }
      let url = try #require(request.url)
      let response = try #require(
        HTTPURLResponse(
          url: url, statusCode: first ? 503 : 200, httpVersion: nil,
          headerFields: ["Content-Type": "application/json", "Retry-After": "5"]))
      return HTTPResult(data: Data("[]".utf8), response: response)
    }, now: { date.withLock { $0 } })
  await #expect(throws: ServiceError.unavailable(retryAfter: Date(timeIntervalSince1970: 1005))) {
    try await api.get("/api")
  }
  date.withLock { $0 = Date(timeIntervalSince1970: 1004) }
  await #expect(throws: ServiceError.unavailable(retryAfter: Date(timeIntervalSince1970: 1005))) {
    try await api.get("/api")
  }
  #expect(requests.withLock { $0 } == 1)
  date.withLock { $0 = Date(timeIntervalSince1970: 1005) }
  _ = try await api.get("/api")
  #expect(requests.withLock { $0 } == 2)
}

@Test func aZeroRetryDelayIsTheCurrentInstant() throws {
  let now = Date(timeIntervalSince1970: 1000)
  let origin = try #require(URL(string: "https://dial.page"))
  let response = try #require(
    HTTPURLResponse(
      url: origin.appendingPathComponent("api"), statusCode: 503, httpVersion: nil,
      headerFields: ["Retry-After": "0"]))
  let api = try APIClient(origin: origin, now: { now })
  #expect(throws: ServiceError.unavailable(retryAfter: now)) {
    try api.validateResponse(response)
  }
}

@Test func downloadFailuresRecordRejectionAndCancellation() async throws {
  let server = try await HTTPTestServer { _ in notFoundResponse }
  for cancelled in [false, true] {
    let trace = RecordingTrace()
    let operation = UUID()
    let api = try APIClient(origin: server.origin, trace: trace)
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let archive = try sampleArchive(bytes: 1)
    let run = Task {
      if cancelled { withUnsafeCurrentTask { $0?.cancel() } }
      return try await TraceContext.$operation.withValue(operation) {
        try await api.download(archive, partials: root)
      }
    }
    if cancelled {
      await #expect(throws: CancellationError.self) { try await run.value }
    } else {
      await #expect(throws: ServiceError.notFound) { try await run.value }
    }
    #expect(
      trace.events.withLock { $0 } == [
        TraceEvent(operation: operation, phase: .download, outcome: .started),
        TraceEvent(
          operation: operation, phase: .download, outcome: cancelled ? .cancelled : .rejected),
      ])
  }
  #expect(server.requestCount == 1)
}

private func descriptors(referringTo held: Int32) -> Set<Int32> {
  var wanted = stat()
  guard fstat(held, &wanted) == 0 else { return [] }
  var result: Set<Int32> = []
  for descriptor in 0..<getdtablesize() {
    var candidate = stat()
    if fstat(descriptor, &candidate) == 0,
      candidate.st_dev == wanted.st_dev, candidate.st_ino == wanted.st_ino
    {
      result.insert(descriptor)
    }
  }
  return result
}

@Test func failedTransferLockAcquisitionsCloseEveryNewDescriptor() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let file = root.appendingPathComponent("transfer.lock")
  try Data().write(to: file)
  let held = try FileHandle(forWritingTo: file)
  defer { try? held.close() }
  #expect(flock(held.fileDescriptor, LOCK_EX | LOCK_NB) == 0)
  let before = descriptors(referringTo: held.fileDescriptor)
  #expect(before == [held.fileDescriptor])
  let server = try await HTTPTestServer { _ in notFoundResponse }
  let api = try APIClient(origin: server.origin)
  let archive = try sampleArchive(bytes: 1)
  for _ in 0..<4 {
    await #expect(throws: ImportError.alreadyUpdating) {
      try await api.download(archive, partials: root)
    }
  }
  #expect(descriptors(referringTo: held.fileDescriptor) == before)
  #expect(server.requestCount == 0)
}

@Test func archiveRequestsKeepTheResumeOffsetTypeAndSelectedNetworkPaths() throws {
  let url = try #require(URL(string: "https://dial.page/api/archive"))
  for paths in NetworkPaths.allCases {
    for offset in [0, 1, 1000] {
      let request = APIClient.downloadRequest(url: url, offset: offset, paths: paths)
      #expect(request.url == url && request.httpMethod == "GET")
      #expect(request.value(forHTTPHeaderField: "Accept") == DatasetArchive.mimeType)
      #expect(
        request.value(forHTTPHeaderField: "Range") == (offset == 0 ? nil : "bytes=\(offset)-"))
      #expect(request.allowsExpensiveNetworkAccess == (paths == .every))
      #expect(request.allowsConstrainedNetworkAccess == (paths == .every))
    }
  }
}

@Test func completedPartialDownloadsReportProgressAndReleaseTheDirectory() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let body = Data("already received".utf8)
  let archive = try sampleArchive(bytes: body.count, digest: sha256Hex(body))
  let file = root.appendingPathComponent(
    "\(archive.snapshot.rawValue)-\(archive.sha256.rawValue).partial")
  try body.write(to: file)
  let server = try await HTTPTestServer { _ in notFoundResponse }
  for _ in 0..<2 {
    let progress = Mutex<[TransferProgress]>([])
    let trace = RecordingTrace()
    let operation = UUID()
    let api = try APIClient(origin: server.origin, trace: trace)
    let saved = try await TraceContext.$operation.withValue(operation) {
      try await api.download(archive, partials: root) { report in
        progress.withLock { $0.append(report) }
      }
    }
    #expect(saved == file)
    #expect(
      progress.withLock { $0 } == [
        TransferProgress(resumed: body.count, received: 0, total: body.count)
      ])
    #expect(
      trace.events.withLock { $0 } == [
        TraceEvent(operation: operation, phase: .download, outcome: .started),
        TraceEvent(operation: operation, phase: .download, outcome: .completed),
      ])
  }
  #expect(server.requestCount == 0)
}
