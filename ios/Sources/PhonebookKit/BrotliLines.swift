import Compression
import Foundation

enum BrotliError: Error, Equatable {
  case corrupt, truncated, lineTooLong, unterminated
}

struct BrotliLines {
  static let maximumLine = 4_194_304
  private static let chunk = 262_144

  private let handle: FileHandle

  init(url: URL) throws { handle = try FileHandle(forReadingFrom: url) }

  /// Calls `body` with each LF-terminated line and the compressed bytes read so far.
  nonisolated(nonsending) func eachLine(_ body: (Data, Int) async throws -> Void) async throws {
    defer { try? handle.close() }
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
        input = try handle.read(upToCount: Self.chunk) ?? Data()
        offset = 0
        exhausted = input.isEmpty
      }
      let (consumed, status) = try input.withUnsafeBytes { raw -> (Int, compression_status) in
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
      offset += consumed
      consumedBytes += consumed
      finished = status == COMPRESSION_STATUS_END
      let produced = Self.chunk - stream.pointee.dst_size
      let bytes = UnsafeRawBufferPointer(start: output, count: produced)
      var start = 0
      for (index, byte) in bytes.enumerated() where byte == 0x0A {
        line.append(contentsOf: bytes[start..<index])
        try await body(line, consumedBytes)
        line.removeAll(keepingCapacity: true)
        start = index + 1
      }
      line.append(contentsOf: bytes[start...])
      guard line.count <= Self.maximumLine else { throw BrotliError.lineTooLong }
      if !finished, exhausted, produced == 0 { throw BrotliError.truncated }
    }
    guard offset == input.count, try handle.read(upToCount: 1)?.isEmpty ?? true else {
      throw BrotliError.corrupt
    }
    guard line.isEmpty else { throw BrotliError.unterminated }
  }
}
