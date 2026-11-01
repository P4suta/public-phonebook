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

@Test func responseSnapshotMustMatchThePinnedRequestAndHeader() async throws {
  let origin = try #require(URL(string: "https://dial.page"))
  let data = discoveryFixture(snapshot: try sampleSnapshot().rawValue)
  let response = try #require(
    HTTPURLResponse(
      url: origin.appendingPathComponent("api/v1"),
      statusCode: 200, httpVersion: nil,
      headerFields: [
        "Content-Type": "application/json", "X-Directory-API-Version": "1",
        "X-Dataset-Snapshot": String(repeating: "b", count: 64),
      ]))
  let api = try APIClient(
    origin: origin, transport: StubTransport(HTTPResult(data: data, response: response)))
  await #expect(throws: ServiceError.self) { try await api.discovery() }
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
      headerFields: ["X-Dataset-Snapshot": snapshot.rawValue, "X-Directory-API-Version": "1"]))
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
