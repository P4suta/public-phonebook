/// What a failed first run or automatic update tells the person, chosen by the one step they can take.
/// Failures that lead to the same step share one notice, and a failure that the app recovers by itself stays silent.
public enum FailureNotice: Sendable, Equatable, CaseIterable {
  /// The first run failed while the person waits, and the app tries again by itself.
  case firstRunRetries
  /// The service publishes a format that this app can't read, so the person updates the app.
  case appTooOld
  /// The first run couldn't confirm what it saved, so the person opens the app again.
  case reopen
  /// An automatic update failed, and the saved data stays in use until the next daily check.
  case silent

  public static func decide(_ error: any Error, saved: Bool) -> FailureNotice {
    if case ServiceError.unsupportedFormat = error { return .appTooOld }
    guard !saved else { return .silent }
    if case ImportError.activationUncertain = error { return .reopen }
    return .firstRunRetries
  }
}
