/// What happens to the operation that a background task protects.
public enum BackgroundTimeEvent: String, CaseIterable, Sendable {
  /// iOS calls the background task's expiry handler.
  case expire
  /// The operation returns or throws, which releases its locks.
  case finish
}

/// What the app does with one background task, which it begins before the operation starts.
public enum BackgroundTime: String, CaseIterable, Sendable {
  /// The operation runs under the background task.
  case running
  /// iOS asked for the time back, and the cancelled operation is unwinding.
  case expiring
  /// The background task has ended.
  case ended

  public struct Step: Equatable, Sendable {
    public let next: BackgroundTime
    /// Cancel the operation, so it unwinds.
    public let cancel: Bool
    /// Release the operation's file and SQLite locks and refuse new ones before the expiry handler returns.
    public let release: Bool
    /// End the background task.
    public let end: Bool
  }

  /// Releases the locks inside every expiry handler before the task ends, so the handler may return at once.
  /// The task ends once the operation finishes.
  public func applying(_ event: BackgroundTimeEvent) -> Step {
    switch (self, event) {
    case (.running, .expire): Step(next: .expiring, cancel: true, release: true, end: false)
    case (.expiring, .expire): Step(next: .expiring, cancel: false, release: true, end: false)
    case (.running, .finish), (.expiring, .finish):
      Step(next: .ended, cancel: false, release: false, end: true)
    case (.ended, _): Step(next: .ended, cancel: false, release: false, end: false)
    }
  }
}
