import Foundation
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
    "https://dial.page#fragment",
  ] {
    #expect(throws: ServiceError.self) { try APIClient(origin: #require(URL(string: origin))) }
  }
}
