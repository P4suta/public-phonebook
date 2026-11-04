import Foundation
import Synchronization

/// The largest file a core test process may write, far over the 15.3 MB largest file of an unmutated build.
/// A runaway writer then fails with File too large instead of filling the disk, and the mutation gate counts that as a resource stop.
let testFileLimit: UInt64 = 256 * 1024 * 1024

/// Caps this test process once and turns a write past the cap into an error instead of a signal.
/// The mutation tool builds in the same process tree as its tests, so only the tests can carry the cap.
private let capped: Bool = {
  var limit = rlimit()
  guard getrlimit(RLIMIT_FSIZE, &limit) == 0 else { return false }
  limit.rlim_cur = min(limit.rlim_max, testFileLimit)
  var ignore = sigaction()
  ignore.__sigaction_u.__sa_handler = SIG_IGN
  return setrlimit(RLIMIT_FSIZE, &limit) == 0 && sigaction(SIGXFSZ, &ignore, nil) == 0
}()

private let emptied = Mutex<Set<String>>([])

/// A directory for one test's files under this checkout's build directory.
/// A process that a mutation run stops early leaves its files there, so the first use in each process empties it.
/// The key names the test and its arguments, so parallel cases and other checkouts never share a directory.
func testDirectory(_ key: String, file: StaticString = #filePath) -> URL {
  precondition(capped, "The test process couldn't cap its file size")
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
