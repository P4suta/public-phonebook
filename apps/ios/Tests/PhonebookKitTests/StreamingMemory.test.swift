import Compression
import CryptoKit
import Darwin
import Foundation
import Synchronization
import Testing

@testable import PhonebookKit

private func memoryFootprint() throws -> UInt64 {
  var info = task_vm_info_data_t()
  var count = mach_msg_type_number_t(
    MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
  let result = withUnsafeMutablePointer(to: &info) {
    $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
      task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
    }
  }
  try #require(result == KERN_SUCCESS)
  return info.phys_footprint
}

@Test func archiveDigestUsesBoundedMemory() throws {
  let isolated = ProcessInfo.processInfo.environment["PHONEBOOK_ISOLATED_FOOTPRINT"] == "1"
  let chunks = isolated ? 100 : 1
  let chunk = Data(repeating: 0, count: 1_048_576)
  var hasher = SHA256()
  for _ in 0..<chunks { hasher.update(data: chunk) }
  let expected = hasher.finalize().map { String(format: "%02x", $0) }.joined()
  let directory = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: directory) }
  let file = directory.appendingPathComponent("sparse-archive")
  #expect(FileManager.default.createFile(atPath: file.path, contents: nil))
  let handle = try FileHandle(forWritingTo: file)
  try handle.seek(toOffset: UInt64(chunks * chunk.count - 1))
  try handle.write(contentsOf: Data([0]))
  try handle.close()
  try autoreleasepool {
    let baseline = try memoryFootprint()
    #expect(try DatasetArchive.digest(of: file) == expected)
    if isolated {
      let peak = try memoryFootprint()
      let growth = peak - min(baseline, peak)
      print("archive.memory bytes=\(chunks * chunk.count) growthKB=\(growth / 1024)")
      #expect(growth < 4 * 1_048_576)
    }
  }
}

@Test func brotliRejectsAnOversizedTerminatedLineBeforePassingItToTheConsumer() async throws {
  let directory = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: directory) }
  let file = directory.appendingPathComponent("oversized-line.br")
  var data = Data(repeating: UInt8(ascii: "a"), count: BrotliLines.maximumLine + 1)
  data.append(0x0A)
  try brotli(data).write(to: file)
  var passed = false
  await #expect(throws: BrotliError.lineTooLong) {
    try await BrotliLines(url: file).eachLine { _, _ in passed = true }
  }
  #expect(!passed)
}

@Test func lineReadersAcceptTheMaximumTerminatedLine() async throws {
  let directory = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: directory) }
  var data = Data(repeating: UInt8(ascii: "a"), count: BrotliLines.maximumLine)
  data.append(0x0A)
  let plain = directory.appendingPathComponent("maximum-line")
  let compressed = directory.appendingPathComponent("maximum-line.br")
  try data.write(to: plain)
  try brotli(data).write(to: compressed)
  var plainLines = 0
  try await PlainLines(url: plain).eachLine { line, _ in
    #expect(line.count == BrotliLines.maximumLine)
    plainLines += 1
  }
  var compressedLines = 0
  try await BrotliLines(url: compressed).eachLine { line, _ in
    #expect(line.count == BrotliLines.maximumLine)
    compressedLines += 1
  }
  #expect(plainLines == 1)
  #expect(compressedLines == 1)
}

@Test func decoderOwnsInitializedStateAndPassesTheFinalizationFlag() throws {
  let encoded = try brotli(Data("one\n".utf8))
  for finalizing in [false, true] {
    let calls = Mutex<[String]>([])
    do {
      let decoder = try BrotliDecoder(
        initialize: { stream, operation, algorithm in
          #expect(operation == COMPRESSION_STREAM_DECODE && algorithm == COMPRESSION_BROTLI)
          calls.withLock { $0.append("initialize") }
          return compression_stream_init(stream, operation, algorithm)
        },
        process: { stream, flags in
          #expect(flags == (finalizing ? Int32(COMPRESSION_STREAM_FINALIZE.rawValue) : 0))
          calls.withLock { $0.append("process") }
          return compression_stream_process(stream, flags)
        },
        destroy: { stream in
          calls.withLock { $0.append("destroy") }
          return compression_stream_destroy(stream)
        })
      let decoded = try decoder.read(encoded, offset: 0, finalizing: finalizing)
      #expect(decoded.consumed == encoded.count && decoded.bytes == Data("one\n".utf8))
      #expect(decoded.state == .finished)
    }
    #expect(calls.withLock { $0 } == ["initialize", "process", "destroy"])
  }
  let releases = Mutex(0)
  #expect(throws: BrotliError.corrupt) {
    try BrotliDecoder(
      initialize: { _, _, _ in COMPRESSION_STATUS_ERROR },
      destroy: { _ in
        releases.withLock { $0 += 1 }
        return COMPRESSION_STATUS_OK
      })
  }
  #expect(releases.withLock { $0 } == 0)
}

@Test func decoderRejectsNoProgressAndReleasesStateAfterFailures() throws {
  for finalizing in [false, true] {
    for failed in [false, true] {
      let releases = Mutex(0)
      do {
        let decoder = try BrotliDecoder(
          process: { _, _ in failed ? COMPRESSION_STATUS_ERROR : COMPRESSION_STATUS_OK },
          destroy: { stream in
            releases.withLock { $0 += 1 }
            return compression_stream_destroy(stream)
          })
        let expected: BrotliError = failed || !finalizing ? .corrupt : .truncated
        #expect(throws: expected) {
          try decoder.read(Data(), offset: 0, finalizing: finalizing)
        }
      }
      #expect(releases.withLock { $0 } == 1)
    }
  }
}

@Test func decoderRefusesInvalidOffsetsAndInvalidFrameworkCounts() throws {
  let calls = Mutex(0)
  let decoder = try BrotliDecoder(process: { _, _ in
    calls.withLock { $0 += 1 }
    return COMPRESSION_STATUS_END
  })
  for offset in [Int.min, -1, 2, Int.max] {
    #expect(throws: BrotliError.corrupt) {
      try decoder.read(Data([1]), offset: offset, finalizing: false)
    }
  }
  #expect(calls.withLock { $0 } == 0)
  for invalid in [-1, Int.max] {
    for source in [false, true] {
      let broken = try BrotliDecoder(process: { stream, _ in
        if source { stream.pointee.src_size = invalid } else { stream.pointee.dst_size = invalid }
        return COMPRESSION_STATUS_OK
      })
      #expect(throws: BrotliError.corrupt) {
        try broken.read(Data([1]), offset: 0, finalizing: false)
      }
    }
  }
}

@Test func decoderUsesTheSourceSliceAndTracksIndependentProgress() throws {
  let plain = Data("one\n".utf8)
  let encoded = try brotli(plain)
  let input = Data([0, 1]) + encoded + Data([2, 3, 4])
  let decoder = try BrotliDecoder()
  let complete = try decoder.read(input, offset: 2, finalizing: true)
  #expect(complete.consumed == encoded.count && complete.bytes == plain)
  #expect(complete.state == .finished)
  for (consumed, produced) in [(1, 0), (0, 1), (1, 1)] {
    let step = try BrotliDecoder(process: { stream, _ in
      #expect(stream.pointee.src_size == 2)
      stream.pointee.src_size -= consumed
      if produced > 0 { stream.pointee.dst_ptr.pointee = 0x41 }
      stream.pointee.dst_size -= produced
      return COMPRESSION_STATUS_OK
    })
    let progress = try step.read(Data([1, 2]), offset: 0, finalizing: false)
    #expect(
      progress.consumed == consumed && progress.bytes == Data(repeating: 0x41, count: produced))
    #expect(progress.state == .more)
  }
  let invalid = try BrotliDecoder(process: { stream, _ in
    stream.pointee.src_size = 2
    return COMPRESSION_STATUS_END
  })
  #expect(throws: BrotliError.corrupt) {
    try invalid.read(Data([1, 2]), offset: 1, finalizing: false)
  }
}

@Test func lineReadersAgreeAcrossInputChunksAndRejectIncompleteStreams() async throws {
  let directory = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: directory) }
  var data = Data()
  var state: UInt64 = 42
  for _ in 0..<700_000 {
    state = state &* 2_862_933_555_777_941_757 &+ 3_037_000_493
    data.append(UInt8(truncatingIfNeeded: state >> 32))
  }
  data.append(0x0A)
  let encoded = try brotli(data)
  #expect(encoded.count > BrotliLines.chunk)
  let expected = data.split(separator: 0x0A, omittingEmptySubsequences: false).dropLast().map(
    Data.init)
  let plain = directory.appendingPathComponent("plain")
  let compressed = directory.appendingPathComponent("compressed")
  try data.write(to: plain)
  try encoded.write(to: compressed)
  var lines: [Data] = []
  try await PlainLines(url: plain).eachLine { line, _ in lines.append(line) }
  #expect(lines == expected)
  lines.removeAll()
  var consumed = 0
  try await BrotliLines(url: compressed).eachLine { line, count in
    #expect(count >= consumed && count <= encoded.count)
    consumed = count
    lines.append(line)
  }
  #expect(lines == expected && consumed == encoded.count)
  let small = try brotli(Data("one\ntwo\n".utf8))
  for length in 0..<small.count {
    try small.prefix(length).write(to: compressed)
    await #expect(throws: BrotliError.self) {
      try await BrotliLines(url: compressed).eachLine { _, _ in }
    }
  }
  try (small + Data([0])).write(to: compressed)
  await #expect(throws: BrotliError.corrupt) {
    try await BrotliLines(url: compressed).eachLine { _, _ in }
  }
  try Data("no final LF".utf8).write(to: plain)
  await #expect(throws: BrotliError.unterminated) {
    try await PlainLines(url: plain).eachLine { _, _ in }
  }
}
