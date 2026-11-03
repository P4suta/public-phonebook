/// What the app knows about caller names, which the reader turns on or off in the iPhone settings.
public enum CallerStatus: String, CaseIterable, Sendable {
  /// The app hasn't asked iOS yet.
  case checking
  case on
  /// iOS reports the extension on, and it didn't take the latest data, so the next launch tries again.
  case onRetrying
  case off
  /// iOS didn't answer.
  case unknown

  public var isOn: Bool { self == .on || self == .onRetrying }

  /// Asks the reader to open the iPhone settings when iOS reports the extension off, the one state that the settings change.
  public var promptsForSettings: Bool { self == .off }
}
