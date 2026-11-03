import Compression
import Foundation

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
    while let chunk = try reading.measure({ try handle.read(upToCount: Self.chunk) }),
      !chunk.isEmpty
    {
      consumed += chunk.count
      var start = chunk.startIndex
      while let end = chunk[start...].firstIndex(of: Self.lineFeed) {
        line.append(contentsOf: chunk[start..<end])
        guard line.count <= BrotliLines.maximumLine else { throw BrotliError.lineTooLong }
        try await body(line, consumed)
        line.removeAll(keepingCapacity: true)
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
  private static let chunk = 262_144

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
    let stream = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
    defer { stream.deallocate() }
    guard
      compression_stream_init(stream, COMPRESSION_STREAM_DECODE, COMPRESSION_BROTLI)
        == COMPRESSION_STATUS_OK
    else { throw BrotliError.corrupt }
    defer { compression_stream_destroy(stream) }
    let output = UnsafeMutablePointer<UInt8>.allocate(capacity: Self.chunk)
    defer { output.deallocate() }
    var line = Data()
    var input = Data()
    var offset = 0
    var consumedBytes = 0
    var exhausted = false
    var finished = false
    while !finished {
      if offset == input.count, !exhausted {
        input = try decoding.measure { try handle.read(upToCount: Self.chunk) } ?? Data()
        offset = 0
        exhausted = input.isEmpty
      }
      let (consumed, status) = try decoding.measure {
        try input.withUnsafeBytes { raw -> (Int, compression_status) in
          let base = raw.bindMemory(to: UInt8.self).baseAddress ?? UnsafePointer(output)
          stream.pointee.src_ptr = base + offset
          stream.pointee.src_size = input.count - offset
          stream.pointee.dst_ptr = output
          stream.pointee.dst_size = Self.chunk
          let flags = exhausted ? Int32(COMPRESSION_STREAM_FINALIZE.rawValue) : 0
          let status = compression_stream_process(stream, flags)
          guard status != COMPRESSION_STATUS_ERROR else { throw BrotliError.corrupt }
          return (input.count - offset - stream.pointee.src_size, status)
        }
      }
      offset += consumed
      consumedBytes += consumed
      finished = status == COMPRESSION_STATUS_END
      let produced = Self.chunk - stream.pointee.dst_size
      var start = 0
      while start < produced, let found = memchr(output + start, 0x0A, produced - start) {
        let end = UnsafeMutableRawPointer(output).distance(to: found)
        line.append(output + start, count: end - start)
        try await body(line, consumedBytes)
        line.removeAll(keepingCapacity: true)
        start = end + 1
      }
      line.append(output + start, count: produced - start)
      guard line.count <= Self.maximumLine else { throw BrotliError.lineTooLong }
      if !finished, exhausted, produced == 0 { throw BrotliError.truncated }
    }
    guard offset == input.count, try handle.read(upToCount: 1)?.isEmpty ?? true else {
      throw BrotliError.corrupt
    }
    guard line.isEmpty else { throw BrotliError.unterminated }
    return decoding.elapsed
  }
}
