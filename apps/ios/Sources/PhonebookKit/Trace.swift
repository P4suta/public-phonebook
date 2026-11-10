import Foundation
import PhonebookCore

public enum TraceContext {
  @TaskLocal public static var operation: UUID?
}

public struct TraceEvent: Codable, Equatable, Sendable {
  public enum Phase: String, Codable, Sendable {
    case request, discovery, catalog, download, delta, decode, stage, activation, cleanup,
      notification, schedule
    /// Parts of an import that report the time they took in `milliseconds`.
    case decompress, parse, insert, numbers, callers, commit, fsync
  }
  public enum Outcome: String, Codable, Sendable {
    case started, completed, cancelled, rejected, deferred
  }
  public let operation: UUID
  public let phase: Phase
  public let outcome: Outcome
  public let snapshot: SnapshotID?
  public let records: UInt64?
  public let milliseconds: UInt64?

  public init(
    operation: UUID? = TraceContext.operation, phase: Phase, outcome: Outcome,
    snapshot: SnapshotID? = nil, records: UInt64? = nil, milliseconds: UInt64? = nil
  ) {
    self.operation = operation ?? UUID()
    self.phase = phase
    self.outcome = outcome
    self.snapshot = snapshot
    self.records = records
    self.milliseconds = milliseconds
  }

  /// A completed import phase and the time it took.
  init(phase: Phase, snapshot: SnapshotID, elapsed: Duration) {
    self.init(
      phase: phase, outcome: .completed, snapshot: snapshot,
      milliseconds: UInt64(max(0, (elapsed / .milliseconds(1)).rounded())))
  }
}

public protocol TraceSink: Sendable { func record(_ event: TraceEvent) }

/// Pairs trace events into the intervals that a signposter marks, and keeps the state of each open interval.
/// A started event opens its phase's interval, the next outcome of that phase closes it, and a completed decode closes the staging that it ends.
/// Every other event is a point, such as the duration of one import phase.
public struct TraceIntervals<State> {
  public struct Key: Hashable, Sendable {
    public let operation: UUID
    public let phase: TraceEvent.Phase
  }

  private var open: [Key: State] = [:]
  public var openCount: Int { open.count }

  public init() {}

  public mutating func record(
    _ event: TraceEvent, begin: (Key) -> State, end: (Key, State) -> Void,
    mark: (TraceEvent) -> Void
  ) {
    let key = Key(operation: event.operation, phase: event.phase)
    if event.outcome == .started {
      if let earlier = open.removeValue(forKey: key) { end(key, earlier) }
      open[key] = begin(key)
      return
    }
    if let state = open.removeValue(forKey: key) {
      end(key, state)
    } else {
      mark(event)
    }
    if event.phase == .decode, event.outcome == .completed {
      let staging = Key(operation: event.operation, phase: .stage)
      if let state = open.removeValue(forKey: staging) { end(staging, state) }
    }
  }
}

public struct DiscardingTraceSink: TraceSink {
  public init() {}
  public func record(_ event: TraceEvent) {}
}

/// Adds up the time that one phase of an import takes across many calls.
struct PhaseTimer {
  private(set) var elapsed = Duration.zero

  mutating func measure<Value>(_ body: () throws -> Value) rethrows -> Value {
    let start = ContinuousClock.now
    defer { elapsed += ContinuousClock.now - start }
    return try body()
  }

  nonisolated(nonsending) mutating func measureAwaiting<Value>(_ body: () async throws -> Value)
    async rethrows -> Value
  {
    let start = ContinuousClock.now
    defer { elapsed += ContinuousClock.now - start }
    return try await body()
  }
}
