import Foundation
import PhonebookCore

public enum PublicURL {
  public static func isValid(_ value: String) -> Bool {
    guard value.utf8.count <= 8192, let url = URL(string: value),
      ["https", "http"].contains(url.scheme), url.host?.isEmpty == false,
      url.user == nil, url.password == nil
    else { return false }
    return true
  }
}

/// The header line of `directory.tsv.br`, which carries the dictionaries that rows index into.
public struct ArchiveHeader: Codable, Sendable {
  public struct Category: Codable, Sendable {
    public let id: String
    public let label: String
    public let publisher: String
    public let license: String
    public let licenseUrl: String
  }
  public struct Prefecture: Codable, Sendable {
    public let code: PrefectureCode
    public let name: String
    public let contacts: Int
  }
  public struct Municipality: Codable, Sendable {
    public let code: String
    public let prefectureCode: PrefectureCode
    public let name: String
  }
  public struct Source: Codable, Sendable {
    public let id: String
    public let url: String
    public let publisher: String?
    public let title: String?
  }
  public struct Provenance: Codable, Sendable {
    public let source: Int
    public let license: String
    public let licenseUrl: String
    public let dataAsOf: String
    public let retrievedAt: String
  }

  public let snapshot: SnapshotID
  public let generatedAt: String
  public let contacts: Int
  public let categories: [Category]
  public let prefectures: [Prefecture]
  public let municipalities: [Municipality]
  public let sources: [Source]
  public let provenances: [Provenance]
  public let links: [String]

  func validated() throws -> Self {
    func text(_ value: String, _ limit: Int = 1024) -> Bool {
      !value.isEmpty && value.utf8.count <= limit
    }
    let codes = prefectures.map(\.code.rawValue)
    guard (0...5_000_000).contains(contacts), generatedAt.utf8.count <= 128,
      (1...255).contains(categories.count), Set(categories.map(\.id)).count == categories.count,
      categories.allSatisfy({
        text($0.id, 256) && text($0.label) && text($0.publisher) && text($0.license)
          && PublicURL.isValid($0.licenseUrl)
      }),
      codes == (1...47).map({ String(format: "%02d", $0) }),
      prefectures.allSatisfy({ text($0.name) && $0.contacts >= 0 }),
      prefectures.reduce(0, { $0 + $1.contacts }) == contacts,
      municipalities.count <= 10_000,
      Set(municipalities.map(\.code)).count == municipalities.count,
      municipalities.allSatisfy({
        ArchiveRecord.isRegion($0.code) && $0.code.count == 5
          && $0.code.hasPrefix($0.prefectureCode.rawValue) && text($0.name)
      }),
      sources.count <= 100_000,
      sources.allSatisfy({
        text($0.id, 256) && PublicURL.isValid($0.url)
          && ($0.publisher.map { text($0) } ?? true) && ($0.title.map { text($0, 4096) } ?? true)
      }),
      provenances.count <= 100_000,
      provenances.allSatisfy({
        sources.indices.contains($0.source) && text($0.license, 8192)
          && PublicURL.isValid($0.licenseUrl) && $0.dataAsOf.utf8.count <= 128
          && $0.retrievedAt.utf8.count <= 128
      }),
      links.count <= 1_000_000, links.allSatisfy(PublicURL.isValid)
    else { throw ImportError.invalidSnapshot }
    return self
  }

  func regionName(_ code: String) -> (prefecture: String, municipality: String?) {
    let prefecture = prefectures.first { $0.code.rawValue == code.prefix(2) }?.name ?? ""
    guard code.count == 5 else { return (prefecture, nil) }
    return (prefecture, municipalities.first { $0.code == code }?.name)
  }
}

/// One contact line of `directory.tsv.br`.
public struct ArchiveRecord: Sendable, Equatable {
  public enum Confirmation: Sendable, Equatable {
    case none, unlinked
    case link(Int)
  }

  public let category: Int
  public let region: String
  public let name: String
  public let address: String
  public let phones: [Phone]
  public let website: String?
  public let provenance: Int
  public let origin: [Int]
  public let confirmation: Confirmation

  public var prefecture: String { String(region.prefix(2)) }

  static let fieldSeparator = UInt8(ascii: "\t")
  static let listSeparator: Character = "\u{1F}"
  static let spellingSeparator: Character = "\u{1E}"

  static func isRegion(_ code: String) -> Bool {
    (code.utf8.count == 2 || code.utf8.count == 5)
      && code.utf8.allSatisfy({ (48...57).contains($0) })
      && (try? PrefectureCode(String(code.prefix(2)))) != nil
  }

  init(line: Data, header: ArchiveHeader) throws {
    let fields = line.split(separator: Self.fieldSeparator, omittingEmptySubsequences: false)
    guard fields.count == 9 else { throw ImportError.invalidRecord }
    func text(_ index: Int) throws -> String {
      guard let value = String(data: fields[index], encoding: .utf8) else {
        throw ImportError.invalidRecord
      }
      return value
    }
    func index(_ value: Substring, below limit: Int) throws -> Int {
      guard !value.isEmpty, value.utf8.count <= 9,
        value.utf8.allSatisfy({ (48...57).contains($0) }),
        let number = Int(value), number < limit, value == "0" || !value.hasPrefix("0")
      else { throw ImportError.invalidRecord }
      return number
    }
    category = try index(Substring(try text(0)), below: header.categories.count)
    region = try text(1)
    name = try text(2)
    address = try text(3)
    let website = try text(5)
    self.website = website.isEmpty ? nil : website
    provenance = try index(Substring(try text(6)), below: header.provenances.count)
    origin = try text(7).split(separator: Self.listSeparator, omittingEmptySubsequences: false)
      .map { try index($0, below: header.links.count) }
    let confirmation = try text(8)
    switch confirmation {
    case "": self.confirmation = .none
    case "*": self.confirmation = .unlinked
    default:
      self.confirmation = .link(try index(Substring(confirmation), below: header.links.count))
    }
    phones = try text(4).split(separator: Self.listSeparator, omittingEmptySubsequences: false)
      .map { entry in
        let parts = entry.split(separator: Self.spellingSeparator, omittingEmptySubsequences: false)
        guard (1...2).contains(parts.count) else { throw ImportError.invalidRecord }
        let display = String(parts[parts.count - 1])
        let national = parts.count == 2 ? String(parts[0]) : display.filter(\.isASCIIDigit)
        let digits = Array(national.utf8)
        guard (10...11).contains(digits.count), digits[0] == 48, (49...57).contains(digits[1]),
          digits.allSatisfy({ (48...57).contains($0) }), !display.isEmpty,
          display.utf8.count <= 128
        else { throw ImportError.invalidRecord }
        return Phone(display: display, e164: try CanonicalPhone("+81" + national.dropFirst()))
      }
    guard Self.isRegion(region), !name.isEmpty, name.utf8.count <= 4096,
      address.utf8.count <= 16_384, (1...32).contains(phones.count),
      Set(phones.map(\.e164)).count == phones.count, (1...1024).contains(origin.count),
      self.website.map(PublicURL.isValid) ?? true
    else { throw ImportError.invalidRecord }
  }
}

extension Character {
  fileprivate var isASCIIDigit: Bool { isASCII && isNumber }
}

/// Reads `directory.tsv.br` as a stream and checks its signature, header, order, and counts.
struct DirectoryArchiveReader {
  static let signature = Data("public-phonebook-directory\t1".utf8)
  static let batchSize = 1_000

  let url: URL

  nonisolated(nonsending) func read(
    header receiveHeader: (ArchiveHeader) async throws -> Void,
    records receiveRecords: ([ArchiveRecord], Int) async throws -> Void
  ) async throws -> ArchiveHeader {
    var line = 0
    var header: ArchiveHeader?
    var previous = Data()
    var batch: [ArchiveRecord] = []
    var counts: [String: Int] = [:]
    var records = 0
    try await BrotliLines(url: url).eachLine { data, consumed in
      defer { line += 1 }
      switch line {
      case 0:
        guard data == Self.signature else { throw ImportError.invalidSnapshot }
      case 1:
        let decoded = try JSONDecoder().decode(ArchiveHeader.self, from: data).validated()
        header = decoded
        try await receiveHeader(decoded)
      default:
        guard let header else { throw ImportError.invalidSnapshot }
        guard records < header.contacts, !Self.precedes(data, previous) else {
          throw ImportError.invalidRecord
        }
        let record = try ArchiveRecord(line: data, header: header)
        counts[record.prefecture, default: 0] += 1
        records += 1
        previous = data
        batch.append(record)
        if batch.count == Self.batchSize {
          try await receiveRecords(batch, consumed)
          batch.removeAll(keepingCapacity: true)
        }
      }
    }
    guard let header else { throw ImportError.invalidSnapshot }
    if !batch.isEmpty { try await receiveRecords(batch, Int.max) }
    guard records == header.contacts,
      header.prefectures.allSatisfy({ counts[$0.code.rawValue, default: 0] == $0.contacts })
    else { throw ImportError.unexpectedCount }
    return header
  }

  static func precedes(_ lhs: Data, _ rhs: Data) -> Bool {
    lhs.withUnsafeBytes { left in
      rhs.withUnsafeBytes { right in
        let common = min(left.count, right.count)
        let order = common == 0 ? 0 : memcmp(left.baseAddress, right.baseAddress, common)
        return order < 0 || (order == 0 && left.count < right.count)
      }
    }
  }
}
