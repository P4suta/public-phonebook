import Foundation
import Testing

@testable import PhonebookCore

private func temporaryFile(_ key: String = #function) -> URL { callerFile(key) }

private func size(_ url: URL) throws -> Int {
  try #require(FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int)
}

private func readAll(_ url: URL) throws -> [(Int64, String)] {
  let reader = try CallerFile.Reader(url: url)
  var entries: [(Int64, String)] = []
  while try reader.read(upTo: 1_000, { entries.append(($0, $1)) }) > 0 {}
  return entries
}

private func varint(_ value: UInt64) -> [UInt8] {
  var bytes: [UInt8] = []
  CallerFile.appendVarint(value, to: &bytes)
  return bytes
}

@Test func varintsHaveTheirExactBytes() {
  #expect(varint(0) == [0])
  #expect(varint(1) == [1])
  #expect(varint(127) == [0x7F])
  #expect(varint(128) == [0x80, 0x01])
  #expect(varint(16_384) == [0x80, 0x80, 0x01])
  #expect(varint(UInt64(Int64.max)) == Array(repeating: 0xFF, count: 8) + [0x7F])
  #expect(varint(.max) == Array(repeating: 0xFF, count: 9) + [0x01])
}

/// The largest record holds the largest step from zero and the longest label.
@Test func theLargestRecordFitsTheRecordBound() throws {
  let url = temporaryFile()
  defer { try? FileManager.default.removeItem(at: url) }
  let label = String(repeating: "a", count: CallerFile.maximumLabelBytes)
  let writer = try CallerFile.Writer(url: url)
  #expect(throws: CallerFile.Failure.label) {
    try writer.append(number: 1, label: label + "a")
  }
  try writer.append(number: .max, label: label)
  try writer.finish()
  let record = try size(url) - CallerFile.header.count
  #expect(record == 9 + 2 + CallerFile.maximumLabelBytes)
  #expect(record <= CallerFile.maximumRecordBytes)
  let entries = try readAll(url)
  #expect(entries.map(\.0) == [.max] && entries.map(\.1) == [label])
}

@Test func theReaderAcceptsTheLargestStepAfterAPreviousNumber() throws {
  let url = temporaryFile()
  defer { try? FileManager.default.removeItem(at: url) }
  let writer = try CallerFile.Writer(url: url)
  try writer.append(number: 1, label: "a")
  try writer.append(number: .max, label: "b")
  try writer.finish()
  #expect(try readAll(url).map(\.0) == [1, .max])
}

@Test func theReaderPassesNoMoreRecordsThanItsLimit() throws {
  let url = temporaryFile()
  defer { try? FileManager.default.removeItem(at: url) }
  let writer = try CallerFile.Writer(url: url)
  for number in 1...3 { try writer.append(number: Int64(number), label: "\(number)") }
  try writer.finish()
  let reader = try CallerFile.Reader(url: url)
  var passed: [Int64] = []
  #expect(try reader.read(upTo: 2) { number, _ in passed.append(number) } == 2)
  #expect(passed == [1, 2])
}

@Test func theReaderRefusesAnEmptyLabelAndAVarintCutAtTheEnd() throws {
  let empty = temporaryFile()
  defer { try? FileManager.default.removeItem(at: empty) }
  try Data(CallerFile.header + [0x01, 0x00]).write(to: empty)
  let reader = try CallerFile.Reader(url: empty)
  #expect(throws: CallerFile.Failure.label) { try reader.read(upTo: 1) { _, _ in } }
  let cut = temporaryFile()
  defer { try? FileManager.default.removeItem(at: cut) }
  try Data(CallerFile.header + [0x80]).write(to: cut)
  let truncated = try CallerFile.Reader(url: cut)
  #expect(throws: CallerFile.Failure.truncated) { try truncated.read(upTo: 1) { _, _ in } }
}

/// Records of 128 bytes fill the 64 KiB buffer at the 512th record, which the writer then writes at once.
@Test func theWriterKeepsRecordsUntilItsBufferFills() throws {
  let url = temporaryFile()
  defer { try? FileManager.default.removeItem(at: url) }
  let label = String(repeating: "a", count: 126)
  let writer = try CallerFile.Writer(url: url)
  try writer.append(number: 1, label: label)
  #expect(try size(url) == CallerFile.header.count)
  for number in 2...511 { try writer.append(number: Int64(number), label: label) }
  #expect(try size(url) == CallerFile.header.count)
  try writer.append(number: 512, label: label)
  #expect(try size(url) == CallerFile.header.count + 65_536)
  try writer.append(number: 513, label: label)
  #expect(try size(url) == CallerFile.header.count + 65_536)
  try writer.finish()
  #expect(try size(url) == CallerFile.header.count + 65_536 + 128)
  #expect(try readAll(url).count == 513)
}
