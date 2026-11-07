import Compression
import Foundation
import PhonebookCore

enum BrotliError: Error, Equatable {
  case corrupt, truncated, lineTooLong, unterminated
}

protocol ArchiveLines {
  /// Calls `body` with each LF-terminated line and the encoded bytes read so far,
  /// and returns the time spent reading and decoding the file outside `body`.
  @discardableResult
  nonisolated(nonsending) func eachLine(_ body: (Data, Int) async throws -> Void) async throws
    -> Duration
}

/// Reads an uncompressed archive, such as one that a delta rebuilt, with the limits of `BrotliLines`.
struct PlainLines: ArchiveLines {
  private static let chunk = 262_144
  private static let lineFeed = UInt8(ascii: "\n")

  private let handle: FileHandle

  init(url: URL) throws { handle = try FileHandle(forReadingFrom: url) }

  @discardableResult
  nonisolated(nonsending) func eachLine(_ body: (Data, Int) async throws -> Void) async throws
    -> Duration
  {
    defer { try? handle.close() }
    var line = Data()
    var consumed = 0
    var reading = PhaseTimer()
    while let chunk = try reading.measure({
      try autoreleasepool { try handle.read(upToCount: Self.chunk) }
    }),
      !chunk.isEmpty
    {
      consumed += chunk.count
      var start = chunk.startIndex
      while let end = chunk[start...].firstIndex(of: Self.lineFeed) {
        line.append(contentsOf: chunk[start..<end])
        guard line.count <= BrotliLines.maximumLine else { throw BrotliError.lineTooLong }
        try await body(line, consumed)
        line.removeSubrange(line.startIndex..<line.endIndex)
        start = chunk.index(after: end)
      }
      line.append(contentsOf: chunk[start...])
      guard line.count <= BrotliLines.maximumLine else { throw BrotliError.lineTooLong }
    }
    guard line.isEmpty else { throw BrotliError.unterminated }
    return reading.elapsed
  }
}

struct BrotliLines: ArchiveLines {
  static let maximumLine = 4_194_304
  static let chunk = 262_144

  private let handle: FileHandle

  init(url: URL) throws { handle = try FileHandle(forReadingFrom: url) }

  /// Calls `body` with each LF-terminated line and the compressed bytes read so far,
  /// and returns the time spent reading and decompressing outside `body`.
  @discardableResult
  nonisolated(nonsending) func eachLine(_ body: (Data, Int) async throws -> Void) async throws
    -> Duration
  {
    defer { try? handle.close() }
    var decoding = PhaseTimer()
    let decoder = try BrotliDecoder()
    var line = Data()
    var input = Data()
    var offset = 0
    var consumedBytes = 0
    var exhausted = false
    var finished = false
    while !finished {
      if offset == input.count, !exhausted {
        input =
          try decoding.measure {
            try autoreleasepool { try handle.read(upToCount: Self.chunk) }
          } ?? Data()
        offset = 0
        exhausted = input.isEmpty
      }
      let decoded = try decoding.measure {
        try decoder.read(input, offset: offset, finalizing: exhausted)
      }
      offset += decoded.consumed
      consumedBytes += decoded.consumed
      finished = decoded.state == .finished
      let output = decoded.bytes
      var start = output.startIndex
      while let end = output[start...].firstIndex(of: 0x0A) {
        line.append(contentsOf: output[start..<end])
        guard line.count <= Self.maximumLine else { throw BrotliError.lineTooLong }
        try await body(line, consumedBytes)
        line.removeSubrange(line.startIndex..<line.endIndex)
        start = output.index(after: end)
      }
      line.append(contentsOf: output[start...])
      guard line.count <= Self.maximumLine else { throw BrotliError.lineTooLong }
    }
    guard offset == input.count, try handle.read(upToCount: 1)?.isEmpty ?? true else {
      throw BrotliError.corrupt
    }
    guard line.isEmpty else { throw BrotliError.unterminated }
    return decoding.elapsed
  }
}

struct BrotliChunk {
  let consumed: Int
  let bytes: Data
  let state: DecodeProgress
}

final class BrotliDecoder {
  typealias Initialize = (
    UnsafeMutablePointer<compression_stream>, compression_stream_operation, compression_algorithm
  ) -> compression_status
  typealias Process = (UnsafeMutablePointer<compression_stream>, Int32) -> compression_status
  typealias Destroy = (UnsafeMutablePointer<compression_stream>) -> compression_status

  private var stream: compression_stream
  private var output = Data(count: BrotliLines.chunk)
  private let process: Process
  private let destroy: Destroy

  init(
    initialize: Initialize = compression_stream_init,
    process: @escaping Process = compression_stream_process,
    destroy: @escaping Destroy = compression_stream_destroy
  ) throws {
    let stream = try withUnsafeTemporaryAllocation(of: compression_stream.self, capacity: 1) {
      buffer in
      guard let pointer = buffer.baseAddress,
        initialize(pointer, COMPRESSION_STREAM_DECODE, COMPRESSION_BROTLI) == COMPRESSION_STATUS_OK
      else { throw BrotliError.corrupt }
      return pointer.pointee
    }
    self.stream = stream
    self.process = process
    self.destroy = destroy
  }

  deinit { _ = destroy(&stream) }

  func read(_ input: Data, offset: Int, finalizing: Bool) throws -> BrotliChunk {
    guard (0...input.count).contains(offset) else { throw BrotliError.corrupt }
    let (consumed, produced, ended) = try output.withUnsafeMutableBytes { destination in
      try input.withUnsafeBytes { source -> (Int, Int, Bool) in
        guard let target = destination.bindMemory(to: UInt8.self).baseAddress else {
          throw BrotliError.corrupt
        }
        let base = source.bindMemory(to: UInt8.self).baseAddress ?? UnsafePointer(target)
        stream.src_ptr = base.advanced(by: offset)
        stream.src_size = input.count - offset
        stream.dst_ptr = target
        stream.dst_size = destination.count
        let flags = finalizing ? Int32(COMPRESSION_STREAM_FINALIZE.rawValue) : 0
        let status = process(&stream, flags)
        guard status != COMPRESSION_STATUS_ERROR else { throw BrotliError.corrupt }
        guard (0...(input.count - offset)).contains(stream.src_size),
          (0...destination.count).contains(stream.dst_size)
        else { throw BrotliError.corrupt }
        return (
          input.count - offset - stream.src_size, destination.count - stream.dst_size,
          status == COMPRESSION_STATUS_END
        )
      }
    }
    let state = DecodeProgress.decide(
      consumed: consumed, produced: produced, ended: ended, exhausted: finalizing)
    switch state {
    case .more, .finished:
      return BrotliChunk(consumed: consumed, bytes: output.prefix(produced), state: state)
    case .corrupt: throw BrotliError.corrupt
    case .truncated: throw BrotliError.truncated
    }
  }
}
