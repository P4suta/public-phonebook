import Foundation

public protocol SnapshotFiles: Sendable {
  func readManifest(at url: URL) throws -> Data
  func activateManifest(_ data: Data, at url: URL) throws
  func removeGeneration(at url: URL) throws
}

public struct LocalSnapshotFiles: SnapshotFiles {
  public init() {}

  public func readManifest(at url: URL) throws -> Data {
    let reader = try FileHandle(forReadingFrom: url)
    defer { try? reader.close() }
    let data = try reader.read(upToCount: 1_048_577) ?? Data()
    guard data.count <= 1_048_576 else { throw ImportError.invalidSnapshot }
    return data
  }

  public func activateManifest(_ data: Data, at url: URL) throws {
    try data.write(to: url, options: .atomic)
  }

  public func removeGeneration(at url: URL) throws {
    try FileManager.default.removeItem(at: url)
  }
}
