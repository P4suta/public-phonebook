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
    /// Cancel the operation, so it unwinds and releases its locks.
    public let cancel: Bool
    /// End the background task.
    public let end: Bool
  }

  /// Ends the task once the operation finishes, so iOS suspends the app only after its locks are released.
  public func applying(_ event: BackgroundTimeEvent) -> Step {
    switch (self, event) {
    case (.running, .expire): Step(next: .expiring, cancel: true, end: false)
    case (.running, .finish), (.expiring, .finish): Step(next: .ended, cancel: false, end: true)
    case (.expiring, .expire), (.ended, _): Step(next: self, cancel: false, end: false)
    }
  }
}
