import Foundation
import PhonebookCore
import Synchronization
import Testing

@testable import PhonebookKit

private actor NotificationFixture: ExtensionNotifier, GenerationReceipts {
  var enabledConsumers: Set<SnapshotConsumer> = [.caller]
  var failures: Set<SnapshotConsumer> = []
  var unavailable: Set<SnapshotConsumer> = []
  var generations: [SnapshotConsumer: UUID] = [:]
  var calls: [SnapshotConsumer] = []

  func configure(
    enabled: Set<SnapshotConsumer>, failures: Set<SnapshotConsumer>,
    unavailable: Set<SnapshotConsumer> = []
  ) {
    enabledConsumers = enabled
    self.failures = failures
    self.unavailable = unavailable
  }
  func seed(_ generations: [SnapshotConsumer: UUID]) { self.generations = generations }
  func enabled(_ consumer: SnapshotConsumer) async throws -> Bool {
    if unavailable.contains(consumer) { throw URLError(.cannotConnectToHost) }
    return enabledConsumers.contains(consumer)
  }
  func notify(_ consumer: SnapshotConsumer) async throws {
    calls.append(consumer)
    if failures.contains(consumer) { throw URLError(.networkConnectionLost) }
  }
  func generation(for consumer: SnapshotConsumer) async -> UUID? { generations[consumer] }
  func record(_ generation: UUID, for consumer: SnapshotConsumer) async {
    generations[consumer] = generation
  }
}

@Test(.timeLimit(.minutes(1)))
func everyConsumerAvailabilityFailureReceiptAndForceCombinationPreservesIndependentProgress()
  async throws
{
  let generation = try #require(UUID(uuidString: "00000000-0000-0000-0000-000000000001"))
  let previous = try #require(UUID(uuidString: "00000000-0000-0000-0000-000000000002"))
  let consumers = SnapshotConsumer.allCases
  #expect(consumers.count == 1)
  var checked = 0
  for bits in 0..<32 {
    let fixture = NotificationFixture()
    let trace = RecordingTrace()
    var enabled: Set<SnapshotConsumer> = []
    var unavailable: Set<SnapshotConsumer> = []
    var failures: Set<SnapshotConsumer> = []
    var forced: Set<SnapshotConsumer> = []
    var before: [SnapshotConsumer: UUID] = [:]
    var expectedStates: [NotificationState] = []
    var expectedCalls: [SnapshotConsumer] = []
    var expectedReceipts: [SnapshotConsumer: UUID] = [:]
    for (index, consumer) in consumers.enumerated() {
      let value = (bits >> (index * 5)) & 31
      if value & 1 != 0 { enabled.insert(consumer) }
      if value & 2 != 0 { unavailable.insert(consumer) }
      if value & 4 != 0 { failures.insert(consumer) }
      if value & 16 != 0 { forced.insert(consumer) }
      let marker = value & 8 != 0 ? generation : previous
      before[consumer] = marker
      expectedReceipts[consumer] = marker
      if unavailable.contains(consumer) {
        expectedStates.append(.unavailable)
      } else if !enabled.contains(consumer) {
        expectedStates.append(.disabled)
      } else if marker == generation && !forced.contains(consumer) {
        expectedStates.append(.current)
      } else {
        expectedCalls.append(consumer)
        expectedStates.append(failures.contains(consumer) ? .failed(.other) : .notified)
        if !failures.contains(consumer) { expectedReceipts[consumer] = generation }
      }
    }
    await fixture.configure(enabled: enabled, failures: failures, unavailable: unavailable)
    await fixture.seed(before)
    let actual = await ExtensionNotifications.refresh(
      generation: generation, notifier: fixture, receipts: fixture, force: forced, trace: trace)
    #expect(actual.map(\.consumer) == consumers)
    #expect(actual.map(\.state) == expectedStates)
    #expect(await fixture.calls == expectedCalls)
    #expect(await fixture.generations == expectedReceipts)
    let events = trace.events.withLock { $0 }
    #expect(events.count == expectedCalls.count * 2)
    for (index, consumer) in expectedCalls.enumerated() {
      #expect(events[index * 2].outcome == .started)
      #expect(
        events[index * 2 + 1].outcome == (failures.contains(consumer) ? .deferred : .completed))
      #expect(events[index * 2].operation == events[index * 2 + 1].operation)
    }
    checked += 1
  }
  #expect(checked == 32)
}

/// Refuses every reload with the Call Directory code it holds.
private struct RefusingNotifier: ExtensionNotifier {
  let code: Int
  func enabled(_ consumer: SnapshotConsumer) async throws -> Bool { true }
  func notify(_ consumer: SnapshotConsumer) async throws { throw CallDirectoryFailure(code: code) }
}

@Test func aRefusedReloadKeepsItsCallDirectoryCodeAndRecordsNoGeneration() async {
  for code in [CallerReply.currentlyLoading, CallerReply.extensionDisabled, 2] {
    let receipts = NotificationFixture()
    let results = await ExtensionNotifications.refresh(
      generation: UUID(), notifier: RefusingNotifier(code: code), receipts: receipts)
    #expect(results.map(\.state) == [.failed(.callDirectory(code: code))])
    #expect(await receipts.generation(for: .caller) == nil)
  }
}

@Test func callerNotificationFailuresRetryUntilTheirGenerationIsRecorded() async {
  let fixture = NotificationFixture()
  let generation = UUID()
  await fixture.configure(enabled: [.caller], failures: [.caller])
  let failed = await ExtensionNotifications.refresh(
    generation: generation, notifier: fixture, receipts: fixture)
  #expect(failed.map(\.state) == [.failed(.other)])
  #expect(await fixture.generation(for: .caller) == nil)
  await fixture.configure(enabled: [.caller], failures: [])
  _ = await ExtensionNotifications.refresh(
    generation: generation, notifier: fixture, receipts: fixture)
  _ = await ExtensionNotifications.refresh(
    generation: generation, notifier: fixture, receipts: fixture)
  #expect(await fixture.calls == [.caller, .caller])
  #expect(await fixture.generation(for: .caller) == generation)
}

@Test func refreshBackoffSurvivesReconstructionAndHandlesMonthEndsInUTC() throws {
  let updated = try #require(ISO8601DateFormatter().date(from: "2026-01-31T12:00:00Z"))
  let monthly = try #require(ISO8601DateFormatter().date(from: "2026-02-28T12:00:00Z"))
  #expect(RefreshPolicy.nextDate(updatedAt: updated, lastAttempt: nil) == monthly)
  let attempt = monthly.addingTimeInterval(100_000)
  let encoded = try JSONEncoder().encode(attempt)
  let restored = try JSONDecoder().decode(Date.self, from: encoded)
  #expect(
    RefreshPolicy.nextDate(updatedAt: updated, lastAttempt: restored)
      == attempt.addingTimeInterval(86_400))
}

@Test func refreshCountsTheMonthFromTheSnapshotsGeneratedDate() throws {
  let saved = try #require(ISO8601DateFormatter().date(from: "2026-11-04T00:00:00Z"))
  let production = try #require(ISO8601DateFormatter().date(from: "2026-11-30T12:23:23Z"))
  #expect(
    abs(
      RefreshPolicy.nextDate(
        generatedAt: "2026-10-30T12:23:23.338Z", savedAt: saved, lastAttempt: nil
      ).timeIntervalSince(production) - 0.338) < 0.001)
  let fixture = try #require(ISO8601DateFormatter().date(from: "2026-11-29T00:00:00Z"))
  #expect(
    RefreshPolicy.nextDate(generatedAt: "2026-10-29T00:00:00Z", savedAt: saved, lastAttempt: nil)
      == fixture)
  let fallback = try #require(ISO8601DateFormatter().date(from: "2026-12-04T00:00:00Z"))
  #expect(
    RefreshPolicy.nextDate(generatedAt: "yesterday", savedAt: saved, lastAttempt: nil) == fallback)
}

@Test(.timeLimit(.minutes(1)))
func automaticRefreshMatchesIndependentGregorianMonthEndsAcrossFourCenturies() throws {
  func days(_ year: Int, _ month: Int) -> Int {
    if month == 2 { return year % 400 == 0 || (year % 4 == 0 && year % 100 != 0) ? 29 : 28 }
    return [4, 6, 9, 11].contains(month) ? 30 : 31
  }
  var calendar = Calendar(identifier: .gregorian)
  calendar.timeZone = .gmt
  var checked = 0
  for year in 2000..<2400 {
    for month in 1...12 {
      let nextYear = month == 12 ? year + 1 : year
      let nextMonth = month == 12 ? 1 : month + 1
      for day in [1, 15, days(year, month)] {
        for second in [0, 45_296, 86_399] {
          let updated = try #require(
            calendar.date(
              from: DateComponents(
                year: year, month: month, day: day, hour: second / 3600,
                minute: second % 3600 / 60, second: second % 60)))
          let monthly = try #require(
            calendar.date(
              from: DateComponents(
                year: nextYear, month: nextMonth, day: min(day, days(nextYear, nextMonth)),
                hour: second / 3600, minute: second % 3600 / 60, second: second % 60)))
          for attempt in [
            nil, monthly.addingTimeInterval(-172_800), monthly.addingTimeInterval(100_000),
          ] {
            let expected = attempt.map { max(monthly, $0.addingTimeInterval(86_400)) } ?? monthly
            #expect(RefreshPolicy.nextDate(updatedAt: updated, lastAttempt: attempt) == expected)
            checked += 1
          }
        }
      }
    }
  }
  #expect(checked == 129_600)
}

final class RecordingTrace: TraceSink {
  let events = Mutex<[TraceEvent]>([])
  func record(_ event: TraceEvent) { events.withLock { $0.append(event) } }
}

@Test func traceSchemaAdmitsOnlyCorrelationAndBoundedOperationalMetadata() throws {
  let id = UUID()
  let event = TraceEvent(
    operation: id, phase: .activation, outcome: .completed,
    snapshot: try sampleSnapshot(), records: 47, milliseconds: 12)
  let data = try JSONEncoder().encode(event)
  let fields = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
  #expect(
    Set(fields.keys) == ["operation", "phase", "outcome", "snapshot", "records", "milliseconds"])
  #expect(try JSONDecoder().decode(TraceEvent.self, from: data) == event)
  let elapsed = TraceEvent(phase: .parse, snapshot: try sampleSnapshot(), elapsed: .seconds(1.2345))
  #expect(elapsed.milliseconds == 1235)
  #expect(elapsed.outcome == .completed)
}

/// Every part of a complete import reports its duration once, so a trace can tell the parts apart.
@Test(.timeLimit(.minutes(1))) func importTracesTheDurationOfEachPhase() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let trace = RecordingTrace()
  let store = try SnapshotStore(root: root, trace: trace)
  let lines = [ArchiveLine(name: "B", phones: "03-0000-0002"), ArchiveLine(name: "A")]
  let url = try writeArchive(
    archiveText(header: sampleHeaderObject(counts: ["13": 2]), lines: lines), in: root)
  _ = try await DirectoryArchiveReader(url: url, trace: trace).read(
    header: { try await store.begin(header: $0) },
    records: { batch, _ in try await store.append(batch) })
  _ = try await store.publish(at: Date())
  let timed = trace.events.withLock { $0 }.filter { $0.milliseconds != nil }
  #expect(
    timed.map(\.phase) == [.decompress, .parse, .insert, .numbers, .callers, .commit, .fsync])
  #expect(timed.allSatisfy { $0.outcome == .completed && $0.snapshot == (try? sampleSnapshot()) })
}
