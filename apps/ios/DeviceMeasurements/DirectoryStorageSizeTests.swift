import Foundation
import XCTest

final class DirectoryStorageSizeTests: XCTestCase {
  func testSparseFilesKeepLogicalAndAllocatedSizesSeparate() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let file = root.appendingPathComponent("sparse")
    XCTAssertTrue(FileManager.default.createFile(atPath: file.path, contents: nil))
    let handle = try FileHandle(forWritingTo: file)
    let offset: UInt64 = 16 * 1024 * 1024
    try handle.seek(toOffset: offset)
    try handle.write(contentsOf: Data([1]))
    try handle.synchronize()
    try handle.close()
    let size = try DirectoryStorageSize.read(in: root)
    XCTAssertEqual(size.logicalBytes, Int(offset) + 1)
    XCTAssertGreaterThan(size.allocatedBytes, 0)
    XCTAssertLessThan(size.allocatedBytes, size.logicalBytes)
  }

  func testEmptyAndMissingDirectoriesHaveDifferentResults() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    XCTAssertThrowsError(try DirectoryStorageSize.read(in: root))
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    XCTAssertEqual(
      try DirectoryStorageSize.read(in: root),
      DirectoryStorageSize(logicalBytes: 0, allocatedBytes: 0))
  }
}
