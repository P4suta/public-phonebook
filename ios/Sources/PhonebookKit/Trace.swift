import Foundation
import PhonebookCore

public enum TraceContext {
  @TaskLocal public static var operation: UUID?
}

public struct TraceEvent: Codable, Equatable, Sendable {
  public enum Phase: String, Codable, Sendable {
    case request, discovery, catalog, download, delta, decode, stage, activation, cleanup,
      notification, schedule
  }
  public enum Outcome: String, Codable, Sendable {
    case started, completed, cancelled, rejected, deferred
  }
  public let operation: UUID
  public let phase: Phase
  public let outcome: Outcome
  public let snapshot: SnapshotID?
  public let records: UInt64?

  public init(
    operation: UUID? = TraceContext.operation, phase: Phase, outcome: Outcome,
    snapshot: SnapshotID? = nil, records: UInt64? = nil
  ) {
    self.operation = operation ?? UUID()
    self.phase = phase
    self.outcome = outcome
    self.snapshot = snapshot
    self.records = records
  }
}

public protocol TraceSink: Sendable { func record(_ event: TraceEvent) }

public struct DiscardingTraceSink: TraceSink {
  public init() {}
  public func record(_ event: TraceEvent) {}
}
