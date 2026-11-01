import Foundation

public enum SnapshotConsumer: String, CaseIterable, Sendable { case caller }
public enum NotificationState: Sendable { case disabled, current, notified, unavailable, failed }
public struct ConsumerResult: Sendable {
  public let consumer: SnapshotConsumer
  public let state: NotificationState
}

public protocol ExtensionNotifier: Sendable {
  func enabled(_ consumer: SnapshotConsumer) async throws -> Bool
  func notify(_ consumer: SnapshotConsumer) async throws
}

public protocol GenerationReceipts: Sendable {
  func generation(for consumer: SnapshotConsumer) async -> UUID?
  func record(_ generation: UUID, for consumer: SnapshotConsumer) async
}

public enum ExtensionNotifications {
  public static func refresh(
    generation: UUID, notifier: any ExtensionNotifier, receipts: any GenerationReceipts,
    force: Set<SnapshotConsumer> = [], trace: any TraceSink = DiscardingTraceSink()
  ) async -> [ConsumerResult] {
    let operation = TraceContext.operation ?? UUID()
    var results: [ConsumerResult] = []
    for consumer in SnapshotConsumer.allCases {
      let enabled: Bool
      do { enabled = try await notifier.enabled(consumer) } catch {
        results.append(ConsumerResult(consumer: consumer, state: .unavailable))
        continue
      }
      guard enabled else {
        results.append(ConsumerResult(consumer: consumer, state: .disabled))
        continue
      }
      if !force.contains(consumer), await receipts.generation(for: consumer) == generation {
        results.append(ConsumerResult(consumer: consumer, state: .current))
        continue
      }
      trace.record(TraceEvent(operation: operation, phase: .notification, outcome: .started))
      do {
        try await notifier.notify(consumer)
        await receipts.record(generation, for: consumer)
        results.append(ConsumerResult(consumer: consumer, state: .notified))
        trace.record(TraceEvent(operation: operation, phase: .notification, outcome: .completed))
      } catch {
        results.append(ConsumerResult(consumer: consumer, state: .failed))
        trace.record(TraceEvent(operation: operation, phase: .notification, outcome: .deferred))
      }
    }
    return results
  }
}
