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
