import Foundation
import Synchronization

private let emptied = Mutex<Set<String>>([])

/// A directory for one test's files under this checkout's build directory.
/// A process that a mutation run stops early leaves its files there, so the first use in each process empties it.
/// The key names the test and its arguments, so parallel cases and other checkouts never share a directory.
func testDirectory(_ key: String, file: StaticString = #filePath) -> URL {
  let name = String(key.map { $0.isLetter || $0.isNumber ? $0 : "-" })
  let directory = URL(fileURLWithPath: "\(file)")
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent(".build/test-files/\(name)", isDirectory: true)
  if emptied.withLock({ $0.insert(name).inserted }) {
    try? FileManager.default.removeItem(at: directory)
  }
  try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  return directory
}

/// A new caller file path in the test's own directory.
func callerFile(_ key: String) -> URL {
  testDirectory(key).appendingPathComponent(UUID().uuidString + ".callers")
}
