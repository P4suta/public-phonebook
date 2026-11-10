import Foundation
import Synchronization

struct DirectoryStorageSize: Equatable, Sendable {
  let logicalBytes: Int
  let allocatedBytes: Int

  static func read(in directory: URL) throws -> Self {
    let failure = Mutex<(any Error)?>(nil)
    let keys: Set<URLResourceKey> = [.isRegularFileKey, .fileSizeKey, .totalFileAllocatedSizeKey]
    guard
      let files = FileManager.default.enumerator(
        at: directory, includingPropertiesForKeys: Array(keys),
        errorHandler: { _, error in
          failure.withLock { $0 = error }
          return false
        })
    else { throw Failure.unreadableDirectory }
    var logical = 0
    var allocated = 0
    for case let file as URL in files {
      let properties = try file.resourceValues(forKeys: keys)
      guard let regular = properties.isRegularFile else { throw Failure.unknownFileKind }
      guard regular else { continue }
      guard let size = properties.fileSize, size >= 0,
        let allocation = properties.totalFileAllocatedSize, allocation >= 0
      else { throw Failure.missingFileSize }
      let logicalSum = logical.addingReportingOverflow(size)
      let allocatedSum = allocated.addingReportingOverflow(allocation)
      guard !logicalSum.overflow, !allocatedSum.overflow else { throw Failure.sizeOverflow }
      logical = logicalSum.partialValue
      allocated = allocatedSum.partialValue
    }
    if let error = failure.withLock({ $0 }) { throw error }
    return Self(logicalBytes: logical, allocatedBytes: allocated)
  }

  private enum Failure: Error {
    case unreadableDirectory, unknownFileKind, missingFileSize, sizeOverflow
  }
}
