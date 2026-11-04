import Foundation
import Testing

@testable import PhonebookCore

private func temporaryFile(_ key: String = #function) -> URL { callerFile(key) }

private func write(_ entries: [(Int64, String)], to url: URL) throws {
  let writer = try CallerFile.Writer(url: url)
  for (number, label) in entries { try writer.append(number: number, label: label) }
  try writer.finish()
}

private func readAll(_ url: URL, chunk: Int = 65_536, batch: Int = 1000) throws -> [(Int64, String)]
{
  let reader = try CallerFile.Reader(url: url, chunk: chunk)
  var entries: [(Int64, String)] = []
  while try reader.read(upTo: batch, { entries.append(($0, $1)) }) > 0 {}
  return entries
}

private struct SplitMix64 {
  private var state: UInt64
  init(seed: UInt64) { state = seed }
  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var value = state
    value = (value ^ (value >> 30)) &* 0xBF58_476D_1CE4_E5B9
    value = (value ^ (value >> 27)) &* 0x94D0_49BB_1331_11EB
    return value ^ (value >> 31)
  }
}

private let alphabet = Array("市役所図書館病院（）・ ABCxyz019-")

@Test(arguments: 0..<100)
func roundTripsAscendingEntriesAcrossChunkBoundaries(seed: Int) throws {
  var random = SplitMix64(seed: UInt64(seed))
  var number: Int64 = 0
  var entries: [(Int64, String)] = []
  for _ in 0..<Int(random.next() % 400) {
    // Steps cover one-byte, multi-byte, and maximum LEB128 deltas.
    let step: Int64 =
      switch random.next() % 3 {
      case 0: 1
      case 1: Int64(random.next() % 1_000_000) + 1
      default: Int64(random.next() % 90_000_000_000) + 1
      }
    number += step
    let length = Int(random.next() % 120) + 1
    let label = String(
      (0..<length).map { _ in alphabet[Int(random.next() % UInt64(alphabet.count))] })
    entries.append((number, label))
  }
  let url = temporaryFile("\(#function)-\(seed)")
  defer { try? FileManager.default.removeItem(at: url) }
  try write(entries, to: url)
  // A chunk of the smallest allowed size forces records to span refills.
  let decoded = try readAll(url, chunk: 1, batch: Int(random.next() % 7) + 1)
  #expect(decoded.map(\.0) == entries.map(\.0))
  #expect(decoded.map(\.1) == entries.map(\.1))
}

@Test func writerRefusesUnorderedDuplicateEmptyAndOversizedEntries() throws {
  let url = temporaryFile()
  defer { try? FileManager.default.removeItem(at: url) }
  let writer = try CallerFile.Writer(url: url)
  try writer.append(number: 81_300_000_000, label: "公開図書館")
  #expect(throws: CallerFile.Failure.order) {
    try writer.append(number: 81_300_000_000, label: "重複")
  }
  #expect(throws: CallerFile.Failure.order) {
    try writer.append(number: 81_200_000_000, label: "逆順")
  }
  #expect(throws: CallerFile.Failure.label) { try writer.append(number: 81_400_000_000, label: "") }
  #expect(throws: CallerFile.Failure.label) {
    try writer.append(
      number: 81_400_000_000, label: String(repeating: "a", count: CallerFile.maximumLabelBytes + 1)
    )
  }
  try writer.finish()
  #expect(try readAll(url).map(\.0) == [81_300_000_000])
}

@Test func readerRefusesAForeignHeaderATruncationAndAZeroStep() throws {
  let url = temporaryFile()
  defer { try? FileManager.default.removeItem(at: url) }
  try Data("something else\n".utf8).write(to: url)
  #expect(throws: CallerFile.Failure.header) { _ = try CallerFile.Reader(url: url) }

  try write([(81_300_000_000, "公開図書館"), (81_300_000_001, "市役所")], to: url)
  let complete = try Data(contentsOf: url)
  try complete.dropLast(2).write(to: url)
  #expect(throws: CallerFile.Failure.truncated) { _ = try readAll(url) }

  // A zero step repeats the previous number, which CallKit refuses as a duplicate.
  var planted = CallerFile.header
  CallerFile.appendVarint(81_300_000_000, to: &planted)
  CallerFile.appendVarint(1, to: &planted)
  planted.append(0x41)
  CallerFile.appendVarint(0, to: &planted)
  CallerFile.appendVarint(1, to: &planted)
  planted.append(0x42)
  try Data(planted).write(to: url)
  #expect(throws: CallerFile.Failure.order) { _ = try readAll(url) }
}

private func footprint() -> UInt64 {
  var info = task_vm_info_data_t()
  var count = mach_msg_type_number_t(
    MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
  let result = withUnsafeMutablePointer(to: &info) {
    $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
      task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
    }
  }
  return result == KERN_SUCCESS ? info.phys_footprint : 0
}

/// Writes more caller entries than the national directory's 561,495 numbers.
private func writeLargeCallerFile(to url: URL) throws {
  let writer = try CallerFile.Writer(url: url)
  for index in 1...600_000 {
    try writer.append(
      number: 81_100_000_000 + Int64(index) * 7, label: "高知県高知市立図書館分室\(index)（図書館）")
  }
  try writer.finish()
}

/// The reader's buffer stays under one chunk plus the largest record, whatever other tests run alongside.
@Test func readerBufferStaysBoundedOverMoreEntriesThanTheNationalDirectory() throws {
  let url = temporaryFile()
  defer { try? FileManager.default.removeItem(at: url) }
  try writeLargeCallerFile(to: url)
  let size = try #require(try url.resourceValues(forKeys: [.fileSizeKey]).fileSize)
  for chunk in [CallerFile.maximumRecordBytes, 65_536] {
    let reader = try CallerFile.Reader(url: url, chunk: chunk)
    var entries = 0
    var last: Int64 = 0
    while true {
      let read = try reader.read(upTo: 1000) { number, _ in last = number }
      guard read > 0 else { break }
      entries += read
    }
    #expect(entries == 600_000)
    #expect(last == 81_100_000_000 + 600_000 * 7)
    #expect(reader.peakBufferedBytes < reader.bufferLimit)
    #expect(reader.bufferLimit * 100 < size)
  }
}

/// The national directory has 561,495 numbers, and the extension may use only 12 MB in total.
/// Concurrent tests would add their own allocations to the footprint, so the iOS gate runs this test alone with the variable set.
@Test(.enabled(if: ProcessInfo.processInfo.environment["PHONEBOOK_ISOLATED_FOOTPRINT"] == "1"))
func readerFootprintStaysFlatWhenRunAlone() throws {
  let url = temporaryFile()
  defer { try? FileManager.default.removeItem(at: url) }
  try writeLargeCallerFile(to: url)
  // The baseline precedes the reader, so a reader that loads the file up front also exceeds the bound.
  let base = footprint()
  let reader = try CallerFile.Reader(url: url)
  var entries = 0
  var last: Int64 = 0
  var peak = footprint()
  while true {
    let read = try autoreleasepool {
      try reader.read(upTo: 1000) { number, _ in
        last = number
      }
    }
    guard read > 0 else { break }
    entries += read
    peak = max(peak, footprint())
  }
  #expect(entries == 600_000)
  #expect(last == 81_100_000_000 + 600_000 * 7)
  #expect(peak - base < 1_048_576)
}

@Test func recordsTheGenerationThatIOSAcceptedAndFindsTheActiveFile() throws {
  let directory = testDirectory(#function)
  defer { try? FileManager.default.removeItem(at: directory) }
  #expect(try CallerFile.active(in: directory) == nil)
  #expect(CallerFile.loadedGeneration(in: directory) == nil)

  let generation = UUID()
  try Data(#"{"format":2,"generation":"\#(generation.uuidString)","records":1}"#.utf8).write(
    to: directory.appendingPathComponent("active.json"))
  #expect(try CallerFile.active(in: directory) == nil)
  let file = directory.appendingPathComponent(generation.uuidString + ".callers")
  try write([(81_300_000_000, "公開図書館")], to: file)
  #expect(
    try CallerFile.active(in: directory) == CallerFile.Active(generation: generation, file: file))

  try CallerFile.recordLoaded(generation, in: directory)
  #expect(CallerFile.loadedGeneration(in: directory) == generation)
  try Data("not a generation".utf8).write(to: directory.appendingPathComponent("callers-loaded"))
  #expect(CallerFile.loadedGeneration(in: directory) == nil)
}

@Test func emptyDirectoryHasOnlyTheHeader() throws {
  let url = temporaryFile()
  defer { try? FileManager.default.removeItem(at: url) }
  try write([], to: url)
  #expect(try Data(contentsOf: url) == Data(CallerFile.header))
  #expect(try readAll(url).isEmpty)
}
