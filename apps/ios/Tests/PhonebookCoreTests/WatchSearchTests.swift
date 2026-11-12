import Foundation
import Testing

@testable import PhonebookCore

@Test func watchRequestsRejectUnsupportedVersionsAndOversizedQueries() throws {
  let id = UUID()
  let request = try WatchSearchRequest(id: id, query: "とうきょう としょかん")
  #expect(try WatchSearchRequest.decode(request.encoded()) == request)
  #expect(throws: WatchSearchError.self) {
    try WatchSearchRequest(id: id, query: " ")
  }
  #expect(throws: WatchSearchError.self) {
    try WatchSearchRequest(id: id, query: String(repeating: "あ", count: 171))
  }
  var wire = try #require(JSONSerialization.jsonObject(with: request.encoded()) as? [String: Any])
  wire["version"] = 2
  let unsupported = try JSONSerialization.data(withJSONObject: wire)
  #expect(throws: WatchSearchError.self) { try WatchSearchRequest.decode(unsupported) }
  #expect(throws: WatchSearchError.self) {
    try WatchSearchRequest.decode(Data(repeating: 32, count: 4097))
  }
}

@Test func watchRepliesValidateResultBoundsAndRetainRequestIdentity() throws {
  let id = UUID()
  let facility = try WatchFacility(
    id: 1, name: "試験図書館", region: "東京都", numbers: ["+81300000000"],
    publisher: "Test city", sourceURL: "https://example.com/directory", license: "CC BY 4.0")
  let reply = try WatchSearchReply(requestID: id, state: .ready, results: [facility], total: 11)
  #expect(try WatchSearchReply.decode(reply.encoded()) == reply)
  #expect(reply.requestID == id)
  #expect(throws: WatchSearchError.self) {
    try WatchSearchReply(requestID: id, state: .ready, results: [facility, facility], total: 2)
  }
  #expect(throws: WatchSearchError.self) {
    try WatchSearchReply(requestID: id, state: .needsPreparation, results: [facility], total: 1)
  }
  #expect(throws: WatchSearchError.self) {
    try WatchSearchReply(requestID: id, state: .ready, results: [facility], total: 0)
  }
  #expect(throws: WatchSearchError.self) {
    try WatchSearchReply.decode(Data(repeating: 32, count: 65_537))
  }
  var wire = try #require(JSONSerialization.jsonObject(with: reply.encoded()) as? [String: Any])
  let result = try #require((wire["results"] as? [Any])?.first)
  wire["results"] = Array(repeating: result, count: 11)
  wire["total"] = 11
  let tooMany = try JSONSerialization.data(withJSONObject: wire)
  #expect(throws: WatchSearchError.self) { try WatchSearchReply.decode(tooMany) }
  var invalidFacility = try #require(result as? [String: Any])
  invalidFacility["numbers"] = ["110"]
  wire["results"] = [invalidFacility]
  let invalidNumber = try JSONSerialization.data(withJSONObject: wire)
  #expect(throws: WatchSearchError.self) { try WatchSearchReply.decode(invalidNumber) }
  wire["results"] = [result]
  wire["version"] = 2
  let unsupported = try JSONSerialization.data(withJSONObject: wire)
  #expect(throws: WatchSearchError.self) { try WatchSearchReply.decode(unsupported) }
}

@Test func watchFacilitiesRejectInvalidNumbersAndUnsafeSources() throws {
  for number in ["110", "+810300000000", "javascript:alert(1)"] {
    #expect(throws: WatchSearchError.self) {
      try WatchFacility(
        id: 1, name: "Test", region: "", numbers: [number], publisher: "Test",
        sourceURL: nil, license: "CC0")
    }
  }
  for source in ["javascript:alert(1)", "file:///private/test", "https://user:pass@example.com"] {
    #expect(throws: WatchSearchError.self) {
      try WatchFacility(
        id: 1, name: "Test", region: "", numbers: ["+81300000000"], publisher: "Test",
        sourceURL: source, license: "CC0")
    }
  }
}

@Test func watchFacilitiesRetainLicenseLinksAndRejectUnsafeLinks() throws {
  let licenseURL = "https://creativecommons.org/licenses/by/4.0/"
  let facility = try WatchFacility(
    id: 1, name: "Test library", region: "", numbers: ["+81300000000"], publisher: "Test city",
    sourceURL: "https://example.com/directory", license: "CC BY 4.0", licenseURL: licenseURL)
  let reply = try WatchSearchReply(requestID: UUID(), state: .ready, results: [facility], total: 1)
  #expect(try WatchSearchReply.decode(reply.encoded()).results.first?.licenseURL == licenseURL)
  #expect(throws: WatchSearchError.self) {
    try WatchFacility(
      id: 1, name: "Test", region: "", numbers: ["+81300000000"], publisher: "Test",
      sourceURL: nil, license: "CC BY 4.0", licenseURL: "javascript:alert(1)")
  }
}

@Test func watchMetadataRejectsValuesAboveTheSnapshotLimit() {
  let value = String(repeating: "a", count: 8193)
  let prefix = "https://example.com/"
  let url = prefix + String(repeating: "a", count: 8193 - prefix.utf8.count)
  for (license, source, licenseURL) in [
    (value, "https://example.com", "https://example.com"),
    ("CC0", url, "https://example.com"),
    ("CC0", "https://example.com", url),
  ] {
    #expect(throws: WatchSearchError.self) {
      try WatchFacility(
        id: 1, name: "Test", region: "", numbers: ["+81300000000"], publisher: "Test",
        sourceURL: source, license: license, licenseURL: licenseURL)
    }
  }
}

@Test func watchRequestsAcceptExactQueryAndWireBounds() throws {
  let id = UUID()
  let query = String(repeating: "a", count: SearchInput.maximumQueryBytes)
  let request = try WatchSearchRequest(id: id, query: query)
  #expect(request.query.utf8.count == SearchInput.maximumQueryBytes)
  #expect(throws: WatchSearchError.self) { try WatchSearchRequest(id: id, query: query + "a") }
  let words = Array(repeating: "a", count: SearchInput.maximumQueryWords).joined(separator: " ")
  _ = try WatchSearchRequest(id: id, query: words)
  #expect(throws: WatchSearchError.self) { try WatchSearchRequest(id: id, query: words + " a") }
  var data = try request.encoded()
  data.append(Data(repeating: 32, count: 4096 - data.count))
  #expect(try WatchSearchRequest.decode(data) == request)
  data.append(32)
  #expect(throws: WatchSearchError.invalidRequest) { try WatchSearchRequest.decode(data) }
}

@Test func watchFacilitiesAcceptClosedMetadataAndTelephoneBounds() throws {
  let text = String(repeating: "a", count: 4096)
  let license = String(repeating: "a", count: 8192)
  let prefix = "https://example.com/"
  let url = prefix + String(repeating: "a", count: 8192 - prefix.utf8.count)
  let numbers = (0..<32).map { "+" + String(81_300_000_000 + $0) }
  _ = try WatchFacility(
    id: 1, name: text, region: text, numbers: numbers, publisher: text, sourceURL: url,
    license: license, licenseURL: url)
  #expect(throws: WatchSearchError.self) {
    try WatchFacility(
      id: 0, name: "a", region: "", numbers: numbers, publisher: "a", sourceURL: nil, license: "a")
  }
  #expect(throws: WatchSearchError.self) {
    try WatchFacility(
      id: 1, name: "a", region: "", numbers: numbers + ["+81300000032"], publisher: "a",
      sourceURL: nil, license: "a")
  }
  for (name, region, publisher) in [
    (text + "a", "", "a"), ("a", text + "a", "a"), ("a", "", text + "a"),
  ] {
    #expect(throws: WatchSearchError.self) {
      try WatchFacility(
        id: 1, name: name, region: region, numbers: ["+81300000000"], publisher: publisher,
        sourceURL: nil, license: "a")
    }
  }
}

@Test func watchRepliesAcceptExactCountsEmptyStatesAndWireBounds() throws {
  let id = UUID()
  let facilities = try (1...WatchSearchReply.maximumResults).map {
    try WatchFacility(
      id: Int64($0), name: "a", region: "", numbers: ["+81300000000"], publisher: "a",
      sourceURL: nil, license: "a")
  }
  let reply = try WatchSearchReply(
    requestID: id, state: .ready, results: facilities, total: Int(Int32.max))
  #expect(reply.results.count == WatchSearchReply.maximumResults)
  #expect(throws: WatchSearchError.self) {
    try WatchSearchReply(
      requestID: id, state: .ready, results: facilities, total: Int(Int32.max) + 1)
  }
  for state in [WatchSearchReply.State.ready, .needsPreparation, .unavailable] {
    _ = try WatchSearchReply(requestID: id, state: state, results: [], total: 0)
    #expect(throws: WatchSearchError.self) {
      try WatchSearchReply(requestID: id, state: state, results: [], total: 1)
    }
  }
  var data = try reply.encoded()
  data.append(Data(repeating: 32, count: 65_536 - data.count))
  #expect(try WatchSearchReply.decode(data) == reply)
  data.append(32)
  #expect(throws: WatchSearchError.invalidReply) { try WatchSearchReply.decode(data) }
}

@Test func watchRepliesRejectContentAboveTheEncodedMessageLimit() throws {
  let facilities = try (1...WatchSearchReply.maximumResults).map {
    try WatchFacility(
      id: Int64($0), name: String(repeating: "a", count: 4096), region: "",
      numbers: ["+81300000000"], publisher: "a", sourceURL: nil,
      license: String(repeating: "a", count: 8192))
  }
  #expect(throws: WatchSearchError.invalidReply) {
    try WatchSearchReply(
      requestID: UUID(), state: .ready, results: facilities, total: facilities.count)
  }
}
