/// The network path that iOS reports, as `NWPath` states its cost.
public struct UpdatePath: Sendable, Equatable, Codable {
  public let expensive: Bool
  public let constrained: Bool

  public init(expensive: Bool, constrained: Bool) {
    self.expensive = expensive
    self.constrained = constrained
  }

  /// Neither expensive nor constrained, such as Wi-Fi outside Low Data Mode.
  public var inexpensive: Bool { !expensive && !constrained }
}

/// The file that an update transfers.
public enum UpdateTransfer: String, Sendable, Equatable, Codable, CaseIterable {
  case delta, archive
}

/// What one read of the dataset listing answered.
public enum ListingReply: String, Sendable, Equatable, Codable, CaseIterable {
  /// The read failed, so it doesn't count as an answer.
  case failed
  /// A 304 reply to the saved ETag.
  case notModified
  /// The listing names the saved snapshot.
  case saved
  /// The listing names another snapshot and a delta from the saved one.
  case delta
  /// The listing names another snapshot and no delta from the saved one.
  case archive
}

/// What the app remembers between checks.
public struct UpdateState: Sendable, Equatable, Codable {
  /// Seconds of the last answered read, or nil before the first one.
  public var answeredAt: Int?
  /// The automatic transfer that waits for a path that is neither expensive nor constrained.
  public var waiting: UpdateTransfer?

  public init(answeredAt: Int? = nil, waiting: UpdateTransfer? = nil) {
    self.answeredAt = answeredAt
    self.waiting = waiting
  }
}

public enum UpdateEvent: Sendable, Equatable {
  /// A launch, a return to the foreground, or a background task at `now`, with what the listing answers if the check reads it.
  case check(now: Int, reply: ListingReply, path: UpdatePath)
  /// iOS reports a path.
  case path(UpdatePath)
  /// The person starts a run after a listing read that answered at `now`, which transfers `transfer` if any.
  case person(now: Int, transfer: UpdateTransfer?, path: UpdatePath)
}

public struct UpdateStart: Sendable, Equatable {
  public let transfer: UpdateTransfer
  /// The daily check or a background task started it, rather than the person.
  public let automatic: Bool
  public let path: UpdatePath

  public init(transfer: UpdateTransfer, automatic: Bool, path: UpdatePath) {
    self.transfer = transfer
    self.automatic = automatic
    self.path = path
  }
}

public struct UpdateStep: Sendable, Equatable {
  public let state: UpdateState
  /// The check read the listing and it answered.
  public let read: Bool
  public let start: UpdateStart?

  public init(state: UpdateState, read: Bool, start: UpdateStart?) {
    self.state = state
    self.read = read
    self.start = start
  }
}

/// Decides when the app reads the listing and which transfer starts on which path, as `verification/ios/UpdateCheck.lean` models.
public enum UpdateCheck {
  public static let intervalSeconds = 86_400

  /// An automatic check reads the listing once a day has passed since the last answered read.
  public static func due(_ state: UpdateState, now: Int) -> Bool {
    guard let answeredAt = state.answeredAt else { return true }
    return now - answeredAt >= intervalSeconds
  }

  /// The transfer that an answered read leaves wanted, where a 304 keeps the one that its ETag's read named.
  static func wanted(_ reply: ListingReply, waiting: UpdateTransfer?) -> UpdateTransfer? {
    switch reply {
    case .failed, .notModified: waiting
    case .saved: nil
    case .delta: .delta
    case .archive: .archive
    }
  }

  public static func step(_ state: UpdateState, _ event: UpdateEvent) -> UpdateStep {
    switch event {
    case .check(let now, let reply, let path):
      guard due(state, now: now), reply != .failed else {
        return UpdateStep(state: state, read: false, start: nil)
      }
      let transfer = wanted(reply, waiting: state.waiting)
      if reply != .notModified, let transfer, path.inexpensive {
        return UpdateStep(
          state: UpdateState(answeredAt: now, waiting: nil), read: true,
          start: UpdateStart(transfer: transfer, automatic: true, path: path))
      }
      return UpdateStep(
        state: UpdateState(answeredAt: now, waiting: transfer), read: true, start: nil)
    case .path(let path):
      guard let waiting = state.waiting, path.inexpensive else {
        return UpdateStep(state: state, read: false, start: nil)
      }
      return UpdateStep(
        state: UpdateState(answeredAt: state.answeredAt, waiting: nil), read: false,
        start: UpdateStart(transfer: waiting, automatic: true, path: path))
    case .person(let now, let transfer, let path):
      return UpdateStep(
        state: UpdateState(answeredAt: now, waiting: nil), read: false,
        start: transfer.map { UpdateStart(transfer: $0, automatic: false, path: path) })
    }
  }
}
