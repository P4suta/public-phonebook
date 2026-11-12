import Foundation

public enum WatchSearchError: Error, Equatable, Sendable {
  case invalidRequest, invalidReply, invalidFacility
}

private func watchMessageData(
  _ data: Data, maximumBytes: Int, failure: WatchSearchError
) throws -> Data {
  guard data.count <= maximumBytes else { throw failure }
  return data
}

public struct WatchSearchRequest: Equatable, Sendable {
  public let id: UUID
  public let query: String

  public init(id: UUID, query: String) throws {
    let words = SearchInput.words(query)
    guard query.utf8.count <= SearchInput.maximumQueryBytes, !words.isEmpty,
      words.count <= SearchInput.maximumQueryWords
    else { throw WatchSearchError.invalidRequest }
    self.id = id
    self.query = query
  }

  private struct Wire: Codable {
    let version: Int
    let id: UUID
    let query: String
  }

  public func encoded() throws -> Data {
    return try watchMessageData(
      JSONEncoder().encode(Wire(version: 1, id: id, query: query)),
      maximumBytes: 4096, failure: .invalidRequest)
  }

  public static func decode(_ data: Data) throws -> Self {
    let data = try watchMessageData(data, maximumBytes: 4096, failure: .invalidRequest)
    do {
      let wire = try JSONDecoder().decode(Wire.self, from: data)
      guard wire.version == 1 else { throw WatchSearchError.invalidRequest }
      return try Self(id: wire.id, query: wire.query)
    } catch { throw WatchSearchError.invalidRequest }
  }
}

public struct WatchFacility: Codable, Hashable, Identifiable, Sendable {
  public let id: Int64
  public let name: String
  public let region: String
  public let numbers: [String]
  public let publisher: String
  public let sourceURL: String?
  public let license: String
  public let licenseURL: String?

  public init(
    id: Int64, name: String, region: String, numbers: [String], publisher: String,
    sourceURL: String?, license: String, licenseURL: String? = nil
  ) throws {
    guard id > 0, !name.isEmpty, !publisher.isEmpty, !license.isEmpty,
      [name, region, publisher].allSatisfy({ $0.utf8.count <= 4096 }),
      license.utf8.count <= 8192,
      !numbers.isEmpty, numbers.count <= 32,
      Set(numbers).count == numbers.count,
      numbers.allSatisfy({ (try? CanonicalPhone($0)) != nil })
    else { throw WatchSearchError.invalidFacility }
    for value in [sourceURL, licenseURL].compactMap({ $0 }) {
      guard value.utf8.count <= 8192,
        let url = URLComponents(string: value),
        url.scheme.map({ ["https", "http"].contains($0) }) == true, url.host?.isEmpty == false,
        url.user == nil, url.password == nil
      else { throw WatchSearchError.invalidFacility }
    }
    self.id = id
    self.name = name
    self.region = region
    self.numbers = numbers
    self.publisher = publisher
    self.sourceURL = sourceURL
    self.license = license
    self.licenseURL = licenseURL
  }

  private enum CodingKeys: String, CodingKey {
    case id, name, region, numbers, publisher, sourceURL, license, licenseURL
  }

  public init(from decoder: any Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    try self.init(
      id: values.decode(Int64.self, forKey: .id),
      name: values.decode(String.self, forKey: .name),
      region: values.decode(String.self, forKey: .region),
      numbers: values.decode([String].self, forKey: .numbers),
      publisher: values.decode(String.self, forKey: .publisher),
      sourceURL: values.decodeIfPresent(String.self, forKey: .sourceURL),
      license: values.decode(String.self, forKey: .license),
      licenseURL: values.decodeIfPresent(String.self, forKey: .licenseURL))
  }
}

public struct WatchSearchReply: Equatable, Sendable {
  public enum State: String, Codable, Sendable {
    case ready, needsPreparation, unavailable
  }

  public static let maximumResults = 10
  public let requestID: UUID
  public let state: State
  public let results: [WatchFacility]
  public let total: Int

  public init(requestID: UUID, state: State, results: [WatchFacility], total: Int) throws {
    guard results.count <= Self.maximumResults,
      Set(results.map(\.id)).count == results.count,
      (0...Int(Int32.max)).contains(total), total >= results.count,
      state == .ready ? (total == 0 || !results.isEmpty) : (results.isEmpty && total == 0)
    else { throw WatchSearchError.invalidReply }
    self.requestID = requestID
    self.state = state
    self.results = results
    self.total = total
    _ = try encoded()
  }

  private struct Wire: Codable {
    let version: Int
    let requestID: UUID
    let state: State
    let results: [WatchFacility]
    let total: Int
  }

  public func encoded() throws -> Data {
    return try watchMessageData(
      JSONEncoder().encode(
        Wire(version: 1, requestID: requestID, state: state, results: results, total: total)),
      maximumBytes: 65_536, failure: .invalidReply)
  }

  public static func decode(_ data: Data) throws -> Self {
    let data = try watchMessageData(data, maximumBytes: 65_536, failure: .invalidReply)
    do {
      let wire = try JSONDecoder().decode(Wire.self, from: data)
      guard wire.version == 1 else { throw WatchSearchError.invalidReply }
      return try Self(
        requestID: wire.requestID, state: wire.state, results: wire.results, total: wire.total)
    } catch { throw WatchSearchError.invalidReply }
  }
}
