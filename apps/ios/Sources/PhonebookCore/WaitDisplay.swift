/// What the line under the current step of the first download says.
public enum WaitLine: Sendable, Equatable {
  case measuring, countdown, longer, almostDone, weakSignal
}

/// One sample of the first download, taken `now` milliseconds after the run started.
/// `stage` counts the steps from 0, and `done` of `total` counts the bytes or rows of that stage.
public struct WaitInput: Sendable, Equatable {
  public let now: Int
  public let stage: Int
  public let done: Int
  public let total: Int
  public let rows: Int
  public let complete: Bool
  /// The transfer waits for a network connection.
  public let waiting: Bool

  public init(
    now: Int, stage: Int, done: Int, total: Int, rows: Int, complete: Bool, waiting: Bool = false
  ) {
    self.now = now
    self.stage = stage
    self.done = done
    self.total = total
    self.rows = rows
    self.complete = complete
    self.waiting = waiting
  }
}

/// What the line shows after one sample, with the countdown's bookkeeping.
struct WaitChoice: Sendable, Equatable {
  let line: WaitLine
  let seconds: Int
  let minutes: Int
  let deadline: Int
  let stableSince: Int
}

/// Decides what the first download's wait shows, and `verification/ios/WaitDisplay.lean` models it function for function.
public struct WaitDisplay: Sendable, Equatable {
  static let firstEstimateMs = 500
  static let lineHoldMs = 1_000
  static let stepHoldMs = 600
  static let fastRunMs = 2_000
  static let fastLimitMs = 4_000
  static let almostMs = 3_000
  static let almostSeconds = 3
  static let shortMs = 60_000
  static let slackMs = 3_000
  static let stableMs = 3_000
  static let minuteHoldMs = 10_000
  static let stallMs = 10_000
  static let millisecondsPerSecond = 1_000
  static let millisecondsPerMinute = 60_000
  static let preparePerKiloRowMs = 7
  static let identifyPerKiloRowMs = 3
  static let rowsPerKilo = 1_000
  static let lastStage = 2
  static let maximumMilliseconds = 2_147_483_647
  static let maximumCount = 268_435_456
  static let unshownSeconds = 2_147_483_647

  public private(set) var now = 0
  public private(set) var line = WaitLine.measuring
  public private(set) var seconds = unshownSeconds
  public private(set) var minutes = 1
  public private(set) var changedAt = 0
  public private(set) var shown = 0
  public private(set) var shownAt = 0
  public private(set) var finished = false
  public private(set) var fast = false
  var deadline = 0
  var stableSince = -1
  var stage = 0
  var total = 0
  var baseAt = 0
  var baseDone = 0
  var lastDone = 0
  var progressAt = 0
  var identifyEnd = 0
  var identifyBudget = 0

  public init() {}

  static func clamp(_ value: Int, _ low: Int, _ high: Int) -> Int { min(max(value, low), high) }

  static func ceilSeconds(_ milliseconds: Int) -> Int {
    (max(milliseconds, 0) + millisecondsPerSecond - 1) / millisecondsPerSecond
  }

  static func coarseMinutes(_ milliseconds: Int) -> Int {
    max(1, (max(milliseconds, 0) + millisecondsPerMinute / 2) / millisecondsPerMinute)
  }

  static func numberOf(_ line: WaitLine, _ seconds: Int, _ minutes: Int) -> Int {
    line == .countdown ? seconds : line == .longer ? minutes : 0
  }

  static func nominalIdentify(_ rows: Int) -> Int { rows * identifyPerKiloRowMs / rowsPerKilo }

  /// The number table and caller file take the observed parsing pace times their share of the measured work.
  static func scaledIdentify(_ rows: Int, _ elapsed: Int, _ gained: Int) -> Int {
    rows * identifyPerKiloRowMs * elapsed / (gained * preparePerKiloRowMs)
  }

  /// Follows the stage, the pace baseline, and the time of the last progress.
  static func track(_ s: Self, _ now: Int, _ stage: Int, _ done: Int, _ total: Int, _ rows: Int)
    -> Self
  {
    var t = s
    t.now = now
    if stage != s.stage || total != s.total {
      t.stage = stage
      t.total = total
      t.baseAt = now
      t.baseDone = done
      t.lastDone = done
      t.progressAt = now
      if stage == lastStage && s.stage != lastStage {
        t.identifyEnd = now + (s.identifyBudget > 0 ? s.identifyBudget : nominalIdentify(rows))
      }
    } else if done > s.lastDone {
      if s.line == .weakSignal {
        t.baseAt = now
        t.baseDone = done
      }
      t.lastDone = done
      t.progressAt = now
    }
    return t
  }

  /// Milliseconds left in the run, or -1 while the stage lacks a measured pace.
  /// The pace runs to the last progress, and the time since then counts as spent, so a pause between bursts never inflates it.
  static func remaining(_ t: Self, _ now: Int, _ total: Int, _ rows: Int) -> Int {
    let elapsed = t.progressAt - t.baseAt
    let gained = t.lastDone - t.baseDone
    if t.stage == lastStage { return max(t.identifyEnd - now, 0) }
    if elapsed < firstEstimateMs || gained <= 0 || total <= 0 { return -1 }
    let left = max(total - t.lastDone, 0) * elapsed / gained
    let idle = now - t.progressAt
    if t.stage == 0 {
      return max(
        left + rows * (preparePerKiloRowMs + identifyPerKiloRowMs) / rowsPerKilo - idle, 0)
    }
    return max(left + scaledIdentify(total, elapsed, gained) - idle, 0)
  }

  /// Keeps the latest measured budget of the last step, and marks a run that should end within the fast time.
  static func refine(_ s: Self, _ t: Self, _ now: Int, _ left: Int) -> Self {
    var r = t
    if t.stage == 1 && left >= 0 {
      r.identifyBudget = scaledIdentify(t.total, t.progressAt - t.baseAt, t.lastDone - t.baseDone)
    }
    if s.line == .measuring && s.changedAt == 0 && !s.fast && left >= 0 && now + left <= fastRunMs {
      r.fast = true
    }
    if r.fast && now > fastLimitMs { r.fast = false }
    return r
  }

  /// Moves the shown step one step toward the stage once the shown step has stayed long enough.
  static func advance(_ s: Self, _ t: Self, _ now: Int, _ stage: Int) -> Self {
    var r = t
    if !t.fast && s.shown < stage && now - s.shownAt >= stepHoldMs {
      r.shown = s.shown + 1
      r.shownAt = now
    }
    return r
  }

  /// Chooses the line from the previous display `s`, the tracked display `t`, and the estimate `left`.
  static func choose(_ s: Self, _ t: Self, _ now: Int, _ left: Int, _ stage: Int, _ waiting: Bool)
    -> WaitChoice
  {
    let keep = WaitChoice(
      line: s.line, seconds: s.seconds, minutes: s.minutes, deadline: t.deadline,
      stableSince: t.stableSince)
    // A transfer that waits for a connection, or has no progress for the stall time, reports a weak signal.
    // It does so even after an estimate said the run was almost done.
    if stage == 0 && (waiting || now - t.progressAt >= stallMs) {
      return WaitChoice(
        line: .weakSignal, seconds: s.seconds, minutes: s.minutes, deadline: t.deadline,
        stableSince: -1)
    }
    if s.line == .almostDone { return keep }
    if left < 0 {
      if s.line == .countdown {
        let next = min(s.seconds, ceilSeconds(t.deadline - now))
        return WaitChoice(
          line: next <= almostSeconds ? .almostDone : .countdown, seconds: next, minutes: s.minutes,
          deadline: t.deadline, stableSince: -1)
      }
      if s.line == .weakSignal {
        return WaitChoice(
          line: .measuring, seconds: s.seconds, minutes: s.minutes, deadline: t.deadline,
          stableSince: -1)
      }
      return keep
    }
    if left <= almostMs {
      return WaitChoice(
        line: .almostDone, seconds: s.seconds, minutes: s.minutes, deadline: t.deadline,
        stableSince: -1)
    }
    let short = left <= shortMs && ceilSeconds(left) <= s.seconds
    if s.line == .countdown {
      if now + left - slackMs > t.deadline || left > shortMs {
        return WaitChoice(
          line: .longer, seconds: s.seconds, minutes: coarseMinutes(left), deadline: t.deadline,
          stableSince: -1)
      }
      let deadline = min(t.deadline, now + left)
      let next = min(s.seconds, ceilSeconds(deadline - now))
      return WaitChoice(
        line: next <= almostSeconds ? .almostDone : .countdown, seconds: next, minutes: s.minutes,
        deadline: deadline, stableSince: -1)
    }
    if s.line == .longer && !short {
      return WaitChoice(
        line: .longer, seconds: s.seconds,
        minutes: now - s.changedAt >= minuteHoldMs ? coarseMinutes(left) : s.minutes,
        deadline: t.deadline, stableSince: -1)
    }
    if s.line == .longer && (t.stableSince < 0 || now - t.stableSince < stableMs) {
      return WaitChoice(
        line: .longer, seconds: s.seconds, minutes: s.minutes, deadline: t.deadline,
        stableSince: t.stableSince < 0 ? now : t.stableSince)
    }
    if short {
      return WaitChoice(
        line: .countdown, seconds: ceilSeconds(left), minutes: s.minutes, deadline: now + left,
        stableSince: -1)
    }
    return WaitChoice(
      line: .longer, seconds: s.seconds, minutes: coarseMinutes(left), deadline: t.deadline,
      stableSince: -1)
  }

  /// The display after one sample, which ignores a sample older than the last one.
  public static func step(_ s: Self, _ input: WaitInput) -> Self {
    let now = clamp(input.now, 0, maximumMilliseconds)
    if s.finished || now < s.now { return s }
    let total = clamp(input.total, 0, maximumCount)
    let done = clamp(input.done, 0, total)
    let rows = clamp(input.rows, 0, maximumCount)
    let stage = clamp(input.stage, 0, lastStage)
    let tracked = track(s, now, stage, done, total, rows)
    let left = remaining(tracked, now, total, rows)
    let refined = refine(s, tracked, now, left)
    if input.complete {
      var r = refined
      r.finished = refined.fast || now <= fastRunMs || now - s.shownAt >= stepHoldMs
      return r
    }
    var r = advance(s, refined, now, stage)
    if r.fast || now - s.changedAt < lineHoldMs { return r }
    let c = choose(s, r, now, left, stage, input.waiting)
    let visible =
      c.line != s.line
      || numberOf(c.line, c.seconds, c.minutes) != numberOf(s.line, s.seconds, s.minutes)
    r.line = c.line
    r.seconds = c.seconds
    r.minutes = c.minutes
    r.deadline = c.deadline
    r.stableSince = c.stableSince
    if visible { r.changedAt = now }
    return r
  }

  /// The countdown's seconds or the coarse minutes that the line shows, or 0 for a line without a number.
  public var number: Int { Self.numberOf(line, seconds, minutes) }
}
