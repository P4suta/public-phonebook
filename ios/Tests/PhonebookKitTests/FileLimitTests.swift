import Foundation
import Testing

/// A sparse write just past the cap shows the limit without writing 256 MiB.
@Test func aKitWritePastTheTestFileLimitFailsInsteadOfGrowing() throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let url = root.appendingPathComponent("runaway")
  #expect(FileManager.default.createFile(atPath: url.path, contents: nil))
  let handle = try FileHandle(forWritingTo: url)
  defer { try? handle.close() }
  try handle.seek(toOffset: testFileLimit - 1)
  let error = #expect(throws: (any Error).self) { try handle.write(contentsOf: Data([0, 0])) }
  #expect(error.map { "\($0)".contains("File too large") } == true)
  let size = try #require(
    FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)
  #expect(size.uint64Value <= testFileLimit)
}
