import Foundation
import PhonebookCore
import Testing

@testable import PhonebookKit

private func read(_ data: Data, compressed: Data? = nil) async throws -> (
  ArchiveHeader, [ArchiveRecord]
) {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let url = root.appendingPathComponent("archive.br")
  try (compressed ?? brotli(data)).write(to: url)
  var received: [ArchiveRecord] = []
  let header = try await DirectoryArchiveReader(url: url).read(
    header: { _ in }, records: { batch, _ in received += batch })
  return (header, received)
}

@Test func archiveRecordsCarryEveryField() async throws {
  let lines = [
    ArchiveLine(
      phones: "03-5321-1111\u{1F}0353211112\u{1E}代表 03(5321)1112", website: "https://example.com/",
      origin: "0\u{1F}1", confirmation: "1"),
    ArchiveLine(category: 1, region: "13", name: "都の窓口", address: "", confirmation: "*"),
  ]
  let (header, records) = try await read(
    archiveText(header: sampleHeaderObject(counts: ["13": 2]), lines: lines))
  #expect(header.contacts == 2)
  let first = try #require(records.first { $0.name == "試験施設" })
  #expect(first.phones.map(\.e164.rawValue) == ["+81353211111", "+81353211112"])
  #expect(first.phones.map(\.display) == ["03-5321-1111", "代表 03(5321)1112"])
  #expect(first.website == "https://example.com/")
  #expect(first.origin == [0, 1])
  #expect(first.confirmation == .link(1))
  let second = try #require(records.first { $0.name == "都の窓口" })
  #expect(second.region == "13")
  #expect(second.confirmation == .unlinked)
  #expect(second.address.isEmpty)
}

@Test func malformedArchivesAreRejected() async throws {
  let valid = try archiveText(header: sampleHeaderObject(), lines: [ArchiveLine()])
  let text = String(decoding: valid, as: UTF8.self)
  let cases: [String] = [
    text.replacingOccurrences(of: "directory\t1", with: "directory\t2"),
    text.replacingOccurrences(of: "\"contacts\":1", with: "\"contacts\":2"),
    text.replacingOccurrences(of: "13101\t", with: "48101\t"),
    text.replacingOccurrences(of: "\t0\t0\t\n", with: "\t5\t0\t\n"),
    text.replacingOccurrences(of: "\t0\t0\t\n", with: "\t0\t9\t\n"),
    text.replacingOccurrences(of: "03-5321-1111", with: "1234"),
    text.replacingOccurrences(of: "\t0\t0\t\n", with: "\t0\t0\t7\n"),
    text.replacingOccurrences(of: "\t0\t0\t\n", with: "\t0\t0\t\textra\n"),
    String(text.dropLast()),
    text + "trailing",
  ]
  for (index, item) in cases.enumerated() {
    await #expect(throws: (any Error).self, "case \(index)") { try await read(Data(item.utf8)) }
  }
  var truncated = try brotli(valid)
  truncated.removeLast(3)
  await #expect(throws: (any Error).self) { try await read(valid, compressed: truncated) }
}

@Test func archiveRowsMustBeSortedAndCounted() async throws {
  let header = sampleHeaderObject(counts: ["13": 2])
  var text = String(
    decoding: try archiveText(
      header: header,
      lines: [
        ArchiveLine(name: "あ"), ArchiveLine(name: "い"),
      ]), as: UTF8.self)
  let rows = text.split(separator: "\n", omittingEmptySubsequences: false)
  text = ([rows[0], rows[1], rows[3], rows[2]].joined(separator: "\n")) + "\n"
  await #expect(throws: ImportError.invalidRecord) { try await read(Data(text.utf8)) }
  let wrongPrefecture = try archiveText(
    header: sampleHeaderObject(counts: ["14": 1]), lines: [ArchiveLine()])
  await #expect(throws: ImportError.unexpectedCount) { try await read(wrongPrefecture) }
  let duplicates = try archiveText(header: header, lines: [ArchiveLine(), ArchiveLine()])
  #expect(try await read(duplicates).1.count == 2)
}

/// The string-based record parser that the byte-level parser replaced, kept unchanged as the reference.
private struct ReferenceRecord: Equatable {
  let category: Int
  let region: String
  let name: String
  let address: String
  let phones: [Phone]
  let website: String?
  let provenance: Int
  let origin: [Int]
  let confirmation: ArchiveRecord.Confirmation

  init(_ record: ArchiveRecord) {
    category = record.category
    region = record.region
    name = record.name
    address = record.address
    phones = record.phones
    website = record.website
    provenance = record.provenance
    origin = record.origin
    confirmation = record.confirmation
  }

  init(line: Data, header: ArchiveHeader) throws {
    let fields = line.split(separator: UInt8(ascii: "\t"), omittingEmptySubsequences: false)
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
    origin = try text(7).split(separator: "\u{1F}", omittingEmptySubsequences: false)
      .map { try index($0, below: header.links.count) }
    let confirmation = try text(8)
    switch confirmation {
    case "": self.confirmation = .none
    case "*": self.confirmation = .unlinked
    default:
      self.confirmation = .link(try index(Substring(confirmation), below: header.links.count))
    }
    phones = try text(4).split(separator: "\u{1F}", omittingEmptySubsequences: false)
      .map { entry in
        let parts = entry.split(separator: "\u{1E}", omittingEmptySubsequences: false)
        guard (1...2).contains(parts.count) else { throw ImportError.invalidRecord }
        let display = String(parts[parts.count - 1])
        let national =
          parts.count == 2 ? String(parts[0]) : display.filter { $0.isASCII && $0.isNumber }
        let digits = Array(national.utf8)
        guard (10...11).contains(digits.count), digits[0] == 48, (49...57).contains(digits[1]),
          digits.allSatisfy({ (48...57).contains($0) }), !display.isEmpty,
          display.utf8.count <= 128
        else { throw ImportError.invalidRecord }
        return Phone(display: display, e164: try CanonicalPhone("+81" + national.dropFirst()))
      }
    guard ArchiveRecord.isRegion(region), !name.isEmpty, name.utf8.count <= 4096,
      address.utf8.count <= 16_384, (1...32).contains(phones.count),
      Set(phones.map(\.e164)).count == phones.count, (1...1024).contains(origin.count),
      self.website.map(PublicURL.isValid) ?? true
    else { throw ImportError.invalidRecord }
  }
}

private struct RecordGenerator {
  private var state: UInt64
  init(seed: UInt64) { state = seed }
  mutating func next(below bound: Int) -> Int {
    state &+= 0x9E37_79B9_7F4A_7C15
    var value = state
    value = (value ^ (value >> 30)) &* 0xBF58_476D_1CE4_E5B9
    value = (value ^ (value >> 27)) &* 0x94D0_49BB_1331_11EB
    return Int((value ^ (value >> 31)) % UInt64(bound))
  }
}

/// Mutated archive lines get the same verdict and the same record from both parsers.
@Test func byteParserMatchesTheStringParserOnEveryMutatedLine() throws {
  let header = try sampleHeader()
  let seeds = [
    ArchiveLine(),
    ArchiveLine(
      phones: "03-5321-1111\u{1F}0353211112\u{1E}代表 03(5321)1112", website: "https://example.com/",
      origin: "0\u{1F}1", confirmation: "1"),
    ArchiveLine(category: 1, region: "13", address: "", confirmation: "*"),
    ArchiveLine(region: "\u{FEFF}13101", phones: "\u{FEFF}03-5321-1111", origin: "\u{FEFF}1"),
    ArchiveLine(name: "ｶﾞｯｺｳ", phones: "代表 03-5321-1111 \u{301}\u{1F}03 5321 1112\r\n"),
    ArchiveLine(phones: "0353211112\u{1E}代表\u{1F}03-5321-1111", confirmation: "\u{FEFF}*"),
  ].map { Array($0.text.utf8) }
  for seed in seeds {
    let record = try ArchiveRecord(line: Data(seed), header: header)
    #expect(ReferenceRecord(record) == (try ReferenceRecord(line: Data(seed), header: header)))
  }
  let insertions: [[UInt8]] = [
    [0x09], [0x1F], [0x1E], [0x30], [0x31], [0x39], [0x2A], [0x2D], [0x20], [0x0D, 0x0A],
    [0xEF, 0xBB, 0xBF], [0xCC, 0x81], [0xE3, 0x82, 0x99], [0xEF, 0xBC, 0x91], [0xC0, 0x80],
    [0xFF], [0xE3, 0x81], Array("https://example.com/a".utf8), Array("0353211113".utf8),
  ]
  var random = RecordGenerator(seed: 0x5EED)
  var accepted = 0
  var rejected = 0
  for _ in 0..<20_000 {
    var line = seeds[random.next(below: seeds.count)]
    for _ in 0...random.next(below: 2) {
      let position = random.next(below: line.count + 1)
      switch random.next(below: 3) {
      case 0:
        line.insert(contentsOf: insertions[random.next(below: insertions.count)], at: position)
      case 1: if position < line.count { line.remove(at: position) }
      default:
        if position < line.count {
          line[position] = insertions[random.next(below: insertions.count)][0]
        }
      }
    }
    let data = Data(line)
    let expected = try? ReferenceRecord(line: data, header: header)
    let actual = try? ArchiveRecord(line: data, header: header)
    #expect(actual.map(ReferenceRecord.init) == expected, "\(line)")
    if expected == nil { rejected += 1 } else { accepted += 1 }
  }
  #expect(accepted > 2_000 && rejected > 2_000, "accepted \(accepted), rejected \(rejected)")
}
