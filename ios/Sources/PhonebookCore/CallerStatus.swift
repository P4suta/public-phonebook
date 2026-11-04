/// What the app knows about caller names, which the reader turns on or off in the iPhone settings.
public enum CallerStatus: String, CaseIterable, Sendable {
  /// The app hasn't asked iOS yet.
  case checking
  case on
  /// iOS reports the extension on and is loading the caller names at the moment.
  case loading
  /// iOS reports the extension on, and it didn't take the latest data, so the next launch tries again.
  case onRetrying
  case off
  /// iOS didn't answer.
  case unknown

  public var isOn: Bool { self == .on || self == .loading || self == .onRetrying }

  /// Asks the reader to open the iPhone settings when iOS reports the extension off, the one state that the settings change.
  public var promptsForSettings: Bool { self == .off }
}

/// What iOS answered when the app asked it to load the caller names again.
public enum CallerReply: Equatable, Sendable {
  case loaded
  /// A `CXErrorCodeCallDirectoryManagerError` code that CallKit returned.
  case callDirectory(code: Int)
  /// An error from outside CallKit's Call Directory domain.
  case other

  /// The codes of `extensionDisabled` and `currentlyLoading` in the iOS SDK's `CXError.h`.
  public static let extensionDisabled = 6
  public static let currentlyLoading = 7

  /// The state that the app shows after this reply for an extension that iOS reported on.
  /// A load that is running isn't a failure, and the app records no generation for it, so the next launch still compares the extension's own record.
  public var status: CallerStatus {
    switch self {
    case .loaded: .on
    case .callDirectory(code: Self.currentlyLoading): .loading
    case .callDirectory(code: Self.extensionDisabled): .off
    case .callDirectory, .other: .onRetrying
    }
  }
}

/// A Call Directory error that the app's CallKit adapter reduced to its code, so the decision needs no CallKit import.
public struct CallDirectoryFailure: Error, Equatable, Sendable {
  public let code: Int
  public init(code: Int) { self.code = code }
}
