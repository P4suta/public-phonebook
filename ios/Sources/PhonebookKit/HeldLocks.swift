import CSQLite
import Foundation
import Synchronization

/// One lock of a synchronization, which any thread may release, and which releases once.
protocol ReleasableLock: AnyObject, Sendable {
  func release()
}

/// The locks of the operation that one background task protects, which its expiry handler releases before it returns.
public final class HeldLocks: Sendable {
  /// The locks of the operation that the current task runs for a background task, if any.
  @TaskLocal static var current: HeldLocks?

  private struct State {
    var refusing = false
    var released = 0
    var locks: [ObjectIdentifier: any ReleasableLock] = [:]
  }

  private let state = Mutex(State())

  public init() {}

  /// The locks that `releaseAll` released, which bounds the expiry handler's work.
  public var released: Int { state.withLock { $0.released } }

  /// Records a lock, or releases it at once after an expiry, so the cancelled work holds no new lock.
  func hold(_ lock: any ReleasableLock) throws {
    let refused = state.withLock { state in
      if !state.refusing { state.locks[ObjectIdentifier(lock)] = lock }
      return state.refusing
    }
    guard refused else { return }
    lock.release()
    throw CancellationError()
  }

  /// Forgets a lock that its owner released.
  func forget(_ lock: any ReleasableLock) {
    _ = state.withLock { $0.locks.removeValue(forKey: ObjectIdentifier(lock)) }
  }

  /// Releases every recorded lock, one step each, and refuses every later one.
  @discardableResult public func releaseAll() -> Int {
    let locks = state.withLock { state in
      state.refusing = true
      let locks = Array(state.locks.values)
      state.locks.removeAll()
      state.released += locks.count
      return locks
    }
    for lock in locks { lock.release() }
    return locks.count
  }
}

/// The exclusive transaction on `writer.sqlite` that keeps two imports apart, which the expiry handler may roll back from the main thread.
final class WriterLease: ReleasableLock {
  private let handle: Mutex<OpaquePointer?>

  init(url: URL) throws {
    var handle: OpaquePointer?
    var status = sqlite3_open_v2(
      url.path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX, nil)
    // Another import holds the lease, so this one fails at once instead of waiting.
    if status == SQLITE_OK { status = sqlite3_busy_timeout(handle, 0) }
    if status == SQLITE_OK { status = sqlite3_exec(handle, "BEGIN EXCLUSIVE", nil, nil, nil) }
    guard status == SQLITE_OK else {
      let failure = DatabaseError.sqlite(status, String(cString: sqlite3_errstr(status)))
      sqlite3_close_v2(handle)
      throw failure
    }
    self.handle = Mutex(handle)
  }

  /// Rolls the transaction back and closes the connection, which no statement shares, so the call never waits for the import.
  func release() {
    handle.withLock { handle in
      guard let open = handle else { return }
      sqlite3_exec(open, "ROLLBACK", nil, nil, nil)
      sqlite3_close_v2(open)
      handle = nil
    }
  }

  deinit { release() }
}
