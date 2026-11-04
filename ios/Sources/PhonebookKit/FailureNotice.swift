/// What a failed first run or update tells the person, chosen by the one step they can take.
/// Failures that lead to the same step share one notice, whatever their internal cause.
public enum FailureNotice: Sendable, Equatable, CaseIterable {
  /// The first run failed, and the app tries again by itself.
  case firstRunRetries
  /// An update failed, and the saved data stays in use.
  case updateKeepsData
  /// The service publishes a format that this app can't read, so the person updates the app.
  case appTooOld
  /// The same, while the saved data stays in use.
  case appTooOldKeepingData
  /// The app couldn't confirm what it saved, so the person opens the app again.
  case reopen

  public static func decide(_ error: any Error, saved: Bool) -> FailureNotice {
    switch error {
    case ServiceError.unsupportedFormat: saved ? .appTooOldKeepingData : .appTooOld
    case ImportError.activationUncertain: .reopen
    default: saved ? .updateKeepsData : .firstRunRetries
    }
  }
}
