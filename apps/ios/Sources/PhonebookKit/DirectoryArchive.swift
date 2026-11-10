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
  static let listSeparator = UInt8(0x1F)
  static let spellingSeparator: Character = "\u{1E}"

  static func isRegion(_ code: String) -> Bool {
    (code.utf8.count == 2 || code.utf8.count == 5)
      && code.utf8.allSatisfy({ (48...57).contains($0) })
      && (try? PrefectureCode(String(code.prefix(2)))) != nil
  }

  init(line: Data, header: ArchiveHeader) throws {
    self = try line.withUnsafeBytes { try Self(bytes: $0.bindMemory(to: UInt8.self), header) }
  }

  /// Parses the nine fields from the line's bytes without copying any field twice.
  ///
  /// Each text field decodes like `String(data:encoding: .utf8)`, which drops one leading byte order mark.
  /// The list and spelling separators are control characters, so splitting bytes at them splits the same places as splitting characters.
  private init(bytes line: UnsafeBufferPointer<UInt8>, _ header: ArchiveHeader) throws {
    var fields = FieldReader(line, separator: Self.fieldSeparator)
    guard fields.count == 9 else { throw ImportError.invalidRecord }
    category = try Self.index(fields.field(), below: header.categories.count)
    region = try Self.text(fields.field())
    name = try Self.text(fields.field())
    address = try Self.text(fields.field())
    let phoneField = try Self.text(fields.field())
    let website = try Self.text(fields.field())
    self.website = website.isEmpty ? nil : website
    provenance = try Self.index(fields.field(), below: header.provenances.count)
    let origin = Self.withoutByteOrderMark(fields.field())
    let confirmation = Self.withoutByteOrderMark(fields.field())
    var links: [Int] = []
    for item in FieldReader(origin, separator: Self.listSeparator) {
      guard links.count < 1024 else { throw ImportError.invalidRecord }
      links.append(try Self.digits(item, below: header.links.count))
    }
    self.origin = links
    if confirmation.isEmpty {
      self.confirmation = .none
    } else if confirmation.count == 1, confirmation[0] == UInt8(ascii: "*") {
      self.confirmation = .unlinked
    } else {
      self.confirmation = .link(try Self.digits(confirmation, below: header.links.count))
    }
    phones = try Self.phones(phoneField)
    guard Self.isRegion(region), !name.isEmpty, name.utf8.count <= 4096,
      address.utf8.count <= 16_384, (1...32).contains(phones.count),
      Self.distinct(phones), (1...1024).contains(self.origin.count),
      self.website.map(PublicURL.isValid) ?? true
    else { throw ImportError.invalidRecord }
  }

  private static let spellingByte = UInt8(0x1E)
  private static let decimalDigits = UInt8(ascii: "0")...UInt8(ascii: "9")

  private static func withoutByteOrderMark(_ bytes: UnsafeBufferPointer<UInt8>)
    -> UnsafeBufferPointer<UInt8>
  {
    guard bytes.count >= 3, bytes[0] == 0xEF, bytes[1] == 0xBB, bytes[2] == 0xBF else {
      return bytes
    }
    return UnsafeBufferPointer(rebasing: bytes[3...])
  }

  private static func text(_ bytes: UnsafeBufferPointer<UInt8>) throws -> String {
    guard let value = String(validating: withoutByteOrderMark(bytes), as: UTF8.self) else {
      throw ImportError.invalidRecord
    }
    return value
  }

  /// Parses a dictionary index field below `limit`.
  private static func index(_ bytes: UnsafeBufferPointer<UInt8>, below limit: Int) throws -> Int {
    try digits(withoutByteOrderMark(bytes), below: limit)
  }

  /// Parses up to nine decimal digits without a sign or a leading zero, as a value below `limit`.
  private static func digits(_ bytes: UnsafeBufferPointer<UInt8>, below limit: Int) throws -> Int {
    guard (1...9).contains(bytes.count), bytes.count == 1 || bytes[0] != decimalDigits.lowerBound
    else { throw ImportError.invalidRecord }
    var value = 0
    for byte in bytes {
      guard decimalDigits.contains(byte) else { throw ImportError.invalidRecord }
      value = value * 10 + Int(byte - decimalDigits.lowerBound)
    }
    guard value < limit else { throw ImportError.invalidRecord }
    return value
  }

  /// Parses each entry of the telephone field, which holds either a display or a national number and a display.
  private static func phones(_ field: String) throws -> [Phone] {
    var field = field
    return try field.withUTF8 { bytes in
      var phones: [Phone] = []
      for entry in FieldReader(bytes, separator: listSeparator) {
        guard phones.count < 32 else { throw ImportError.invalidRecord }
        var parts = FieldReader(entry, separator: spellingByte)
        guard (1...2).contains(parts.count) else { throw ImportError.invalidRecord }
        let first = parts.field()
        let displayBytes = parts.count == 2 ? parts.field() : first
        let display = String(decoding: displayBytes, as: UTF8.self)
        let national: String
        if parts.count == 2 {
          national = String(decoding: first, as: UTF8.self)
        } else if displayBytes.allSatisfy({ $0 < 0x80 }) {
          // In ASCII text every digit is its own character, so the byte filter matches the character filter.
          national = String(decoding: displayBytes.filter(decimalDigits.contains), as: UTF8.self)
        } else {
          national = display.filter(\.isASCIIDigit)
        }
        let digits = national.utf8
        guard (10...11).contains(digits.count), digits.first == decimalDigits.lowerBound,
          digits.dropFirst().first.map({ (49...57).contains($0) }) == true,
          digits.allSatisfy(decimalDigits.contains), !displayBytes.isEmpty,
          displayBytes.count <= 128
        else { throw ImportError.invalidRecord }
        phones.append(
          Phone(display: display, e164: try CanonicalPhone("+81" + national.dropFirst())))
      }
      return phones
    }
  }

  /// A canonical number spells exactly one integer, so distinct integers mean distinct numbers.
  private static func distinct(_ phones: [Phone]) -> Bool {
    for (index, phone) in phones.enumerated() {
      for other in phones[(index + 1)...] where other.e164.number == phone.e164.number {
        return false
      }
    }
    return true
  }
}

/// Walks the fields of a byte buffer between single-byte separators, keeping empty fields.
private struct FieldReader: Sequence, IteratorProtocol {
  private let bytes: UnsafeBufferPointer<UInt8>
  private let separator: UInt8
  private var start = 0
  private var finished = false
  /// The number of fields, which is one more than the number of separators.
  let count: Int

  init(_ bytes: UnsafeBufferPointer<UInt8>, separator: UInt8) {
    self.bytes = bytes
    self.separator = separator
    var fields = 1
    var position = 0
    while let end = Self.separator(separator, in: bytes, from: position) {
      fields += 1
      position = end + 1
    }
    count = fields
  }

  private static func separator(
    _ byte: UInt8, in bytes: UnsafeBufferPointer<UInt8>, from start: Int
  )
    -> Int?
  {
    guard start < bytes.count, let base = bytes.baseAddress,
      let found = memchr(base + start, Int32(byte), bytes.count - start)
    else { return nil }
    return base.distance(to: found.assumingMemoryBound(to: UInt8.self))
  }

  mutating func next() -> UnsafeBufferPointer<UInt8>? {
    guard !finished else { return nil }
    let end = Self.separator(separator, in: bytes, from: start) ?? bytes.count
    let field = UnsafeBufferPointer(rebasing: bytes[start..<end])
    finished = end == bytes.count
    start = end + 1
    return field
  }

  /// The next field, or an empty field after the last one.
  mutating func field() -> UnsafeBufferPointer<UInt8> {
    next() ?? UnsafeBufferPointer(rebasing: bytes[bytes.count...])
  }
}

extension Character {
  fileprivate var isASCIIDigit: Bool { isASCII && isNumber }
}

extension ArchiveRecord {
  private static let countryPrefix = "+81"
  private static let trunkPrefix = "0"
  private static let asciiDigits = UInt8(ascii: "0")...UInt8(ascii: "9")

  /// Spells a saved telephone as an archive field, the same way `src/core/directory-archive.ts` does.
  static func telephone(e164: Substring, display: Substring) -> String {
    let national = trunkPrefix + e164.dropFirst(countryPrefix.count)
    let digits = String(decoding: display.utf8.filter { asciiDigits.contains($0) }, as: UTF8.self)
    return digits == national ? String(display) : national + String(spellingSeparator) + display
  }
}

/// Reads `directory.tsv.br`, or an archive that a delta rebuilt, and checks its signature, header, order, and counts.
struct DirectoryArchiveReader {
  enum Encoding { case brotli, plain }

  static let signature = Data("public-phonebook-directory\t1".utf8)
  static let batchSize = 1_000

  let url: URL
  var encoding = Encoding.brotli
  var trace: any TraceSink = DiscardingTraceSink()

  /// Passes the header and then batches of validated records, and traces the time spent decompressing and parsing.
  nonisolated(nonsending) func read(
    header receiveHeader: (ArchiveHeader) async throws -> Void,
    records receiveRecords: ([ArchiveRecord], Int) async throws -> Void
  ) async throws -> ArchiveHeader {
    var line = 0
    var header: ArchiveHeader?
    // A separate copy keeps the reader's line buffer uniquely owned, so the reader reuses it.
    var previous: [UInt8] = []
    var batch: [ArchiveRecord] = []
    // Indexed by prefecture number, which `ArchiveRecord` limits to 1 through 47.
    var counts = [Int](repeating: 0, count: 48)
    var records = 0
    var receiving = PhaseTimer()
    let start = ContinuousClock.now
    let lines: any ArchiveLines =
      switch encoding {
      case .brotli: try BrotliLines(url: url)
      case .plain: try PlainLines(url: url)
      }
    let decoding = try await lines.eachLine { data, consumed in
      defer { line += 1 }
      switch line {
      case 0:
        guard data == Self.signature else { throw ImportError.invalidSnapshot }
      case 1:
        let decoded = try JSONDecoder().decode(ArchiveHeader.self, from: data).validated()
        header = decoded
        try await receiving.measureAwaiting { try await receiveHeader(decoded) }
      default:
        guard let header else { throw ImportError.invalidSnapshot }
        guard records < header.contacts, !Self.precedes(data, previous) else {
          throw ImportError.invalidRecord
        }
        let record = try ArchiveRecord(line: data, header: header)
        counts[Self.prefectureNumber(record.region)] += 1
        records += 1
        previous.removeAll(keepingCapacity: true)
        previous.append(contentsOf: data)
        batch.append(record)
        if batch.count == Self.batchSize {
          try await receiving.measureAwaiting { try await receiveRecords(batch, consumed) }
          batch.removeAll(keepingCapacity: true)
        }
      }
    }
    guard let header else { throw ImportError.invalidSnapshot }
    if !batch.isEmpty {
      try await receiving.measureAwaiting { try await receiveRecords(batch, Int.max) }
    }
    guard records == header.contacts,
      header.prefectures.allSatisfy({
        counts[Self.prefectureNumber($0.code.rawValue)] == $0.contacts
      })
    else { throw ImportError.unexpectedCount }
    let parsing = ContinuousClock.now - start - decoding - receiving.elapsed
    trace.record(TraceEvent(phase: .decompress, snapshot: header.snapshot, elapsed: decoding))
    trace.record(TraceEvent(phase: .parse, snapshot: header.snapshot, elapsed: parsing))
    return header
  }

  /// The number that a validated region or prefecture code starts with.
  private static func prefectureNumber(_ code: String) -> Int {
    var number = 0
    for byte in code.utf8.prefix(2) { number = number * 10 + Int(byte) - Int(UInt8(ascii: "0")) }
    return number
  }

  static func precedes(_ lhs: Data, _ rhs: some ContiguousBytes) -> Bool {
    lhs.withUnsafeBytes { left in
      rhs.withUnsafeBytes { right in
        let common = min(left.count, right.count)
        let order = common == 0 ? 0 : memcmp(left.baseAddress, right.baseAddress, common)
        return order < 0 || (order == 0 && left.count < right.count)
      }
    }
  }
}
