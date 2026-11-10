import Foundation
import Testing

@testable import PhonebookCore

/// Setting this variable to a path writes the contract there instead of comparing it.
private let contractOutput = "PHONEBOOK_UPDATE_CONTRACT_OUTPUT"
private let day = UpdateCheck.intervalSeconds
private let paths = [false, true].flatMap { expensive in
  [false, true].map { UpdatePath(expensive: expensive, constrained: $0) }
}

/// A seeded generator, so every run checks the same traces.
private struct SplitMix {
  var state: UInt64
  mutating func next(_ bound: Int) -> Int {
    state &+= 0x9E37_79B9_7F4A_7C15
    var value = state
    value = (value ^ (value >> 30)) &* 0xBF58_476D_1CE4_E5B9
    value = (value ^ (value >> 27)) &* 0x94D0_49BB_1331_11EB
    return Int((value ^ (value >> 31)) % UInt64(bound))
  }
}

/// A trace whose clock moves forward by up to two days between events, so checks fall on both sides of the interval.
private func trace(seed: UInt64, events count: Int) -> [UpdateEvent] {
  var random = SplitMix(state: seed)
  var now = 0
  return (0..<count).map { _ in
    now += random.next(2 * day)
    let path = paths[random.next(paths.count)]
    switch random.next(4) {
    case 0, 1:
      return .check(
        now: now, reply: ListingReply.allCases[random.next(ListingReply.allCases.count)],
        path: path)
    case 2: return .path(path)
    default:
      let transfers: [UpdateTransfer?] = [nil, .delta, .archive]
      return .person(now: now, transfer: transfers[random.next(transfers.count)], path: path)
    }
  }
}

private func steps(_ events: [UpdateEvent]) -> [UpdateStep] {
  var state = UpdateState()
  return events.map { event in
    let step = UpdateCheck.step(state, event)
    state = step.state
    return step
  }
}

/// The record's rules, stated for one step without the decision's own structure.
private func expected(_ state: UpdateState, _ event: UpdateEvent) -> UpdateStep {
  func automatic(_ transfer: UpdateTransfer, _ path: UpdatePath) -> UpdateStart {
    UpdateStart(transfer: transfer, automatic: true, path: path)
  }
  switch event {
  case .path(let path):
    if let waiting = state.waiting, !path.expensive, !path.constrained {
      return UpdateStep(
        state: UpdateState(answeredAt: state.answeredAt), read: false,
        start: automatic(waiting, path))
    }
    return UpdateStep(state: state, read: false, start: nil)
  case .person(let now, let transfer, let path):
    return UpdateStep(
      state: UpdateState(answeredAt: now), read: false,
      start: transfer.map { UpdateStart(transfer: $0, automatic: false, path: path) })
  case .check(let now, let reply, let path):
    let due = state.answeredAt.map { now >= $0 + day } ?? true
    if !due || reply == .failed { return UpdateStep(state: state, read: false, start: nil) }
    let cheap = !path.expensive && !path.constrained
    switch reply {
    case .failed, .notModified:
      return UpdateStep(
        state: UpdateState(answeredAt: now, waiting: state.waiting), read: true, start: nil)
    case .saved: return UpdateStep(state: UpdateState(answeredAt: now), read: true, start: nil)
    case .delta, .archive:
      let transfer: UpdateTransfer = reply == .delta ? .delta : .archive
      return cheap
        ? UpdateStep(
          state: UpdateState(answeredAt: now), read: true, start: automatic(transfer, path))
        : UpdateStep(
          state: UpdateState(answeredAt: now, waiting: transfer), read: true, start: nil)
    }
  }
}

/// Every boundary state against every event at the interval's edges, on every path.
@Test func updateStepFollowsTheRecordOnEveryBoundaryInput() {
  let times = [-1, 0, day - 1, day, day + 1, 2 * day]
  let states = [nil, 0, 1].flatMap { answeredAt in
    [nil, UpdateTransfer.delta, .archive].map { UpdateState(answeredAt: answeredAt, waiting: $0) }
  }
  var events: [UpdateEvent] = paths.map { .path($0) }
  for now in times {
    for path in paths {
      events += ListingReply.allCases.map { .check(now: now, reply: $0, path: path) }
      events += [nil, UpdateTransfer.delta, .archive].map {
        .person(now: now, transfer: $0, path: path)
      }
    }
  }
  var checked = 0
  for state in states {
    for event in events {
      #expect(UpdateCheck.step(state, event) == expected(state, event), "\(state) \(event)")
      checked += 1
    }
  }
  #expect(checked == 9 * (4 + 6 * 4 * 8))
}

/// The five properties of the Lean model, checked natively on 2,000 seeded traces of 16 events.
@Test func updatePropertiesHoldOnSeededTraces() {
  for seed in 1...2_000 {
    var state = UpdateState()
    for event in trace(seed: UInt64(seed), events: 16) {
      let step = UpdateCheck.step(state, event)
      if step.read {
        guard case .check(let now, _, _) = event else {
          Issue.record("seed \(seed): a read without a check")
          continue
        }
        #expect(
          state.answeredAt.map { now - $0 >= day } ?? true, "seed \(seed): two reads in a day")
        #expect(step.state.answeredAt == now)
      }
      if let start = step.start, start.automatic {
        #expect(start.path.inexpensive, "seed \(seed): an automatic start on a costly path")
      }
      switch event {
      case .path(let path) where path.inexpensive:
        #expect(
          step.start == state.waiting.map { UpdateStart(transfer: $0, automatic: true, path: path) }
        )
      case .person(_, let transfer?, let path):
        #expect(step.start == UpdateStart(transfer: transfer, automatic: false, path: path))
      case .check(_, let reply, _) where reply == .notModified || reply == .saved:
        #expect(step.start == nil)
      default: break
      }
      state = step.state
    }
  }
}

private struct UpdateContract: Codable, Equatable {
  struct Event: Codable, Equatable {
    let kind: String
    let now: Int?
    let reply: String?
    let transfer: String?
    let expensive: Bool
    let constrained: Bool
  }
  struct Start: Codable, Equatable {
    let transfer: String
    let automatic: Bool
    let expensive: Bool
    let constrained: Bool
  }
  struct Step: Codable, Equatable {
    let answeredAt: Int?
    let waiting: String?
    let read: Bool
    let start: Start?
  }
  struct Trace: Codable, Equatable {
    let seed: Int
    let events: [Event]
    let steps: [Step]
  }
  let traces: [Trace]
}

private func record(_ event: UpdateEvent) -> UpdateContract.Event {
  switch event {
  case .check(let now, let reply, let path):
    .init(
      kind: "check", now: now, reply: reply.rawValue, transfer: nil, expensive: path.expensive,
      constrained: path.constrained)
  case .path(let path):
    .init(
      kind: "path", now: nil, reply: nil, transfer: nil, expensive: path.expensive,
      constrained: path.constrained)
  case .person(let now, let transfer, let path):
    .init(
      kind: "person", now: now, reply: nil, transfer: transfer?.rawValue,
      expensive: path.expensive, constrained: path.constrained)
  }
}

private func record(_ step: UpdateStep) -> UpdateContract.Step {
  .init(
    answeredAt: step.state.answeredAt, waiting: step.state.waiting?.rawValue, read: step.read,
    start: step.start.map {
      .init(
        transfer: $0.transfer.rawValue, automatic: $0.automatic, expensive: $0.path.expensive,
        constrained: $0.path.constrained)
    })
}

/// The Swift decision produces the recorded steps, which the Lean model must reproduce in the proof gate.
@Test func everyUpdateTraceRefinesTheProofContract() throws {
  let computed = UpdateContract(
    traces: (1...10).map { seed in
      let events = trace(seed: UInt64(seed), events: 12)
      return .init(seed: seed, events: events.map(record), steps: steps(events).map(record))
    })
  if let output = ProcessInfo.processInfo.environment[contractOutput] {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    try encoder.encode(computed).write(to: URL(fileURLWithPath: output))
  }
  let url = try #require(Bundle.module.url(forResource: "UpdateContract", withExtension: "json"))
  let recorded = try JSONDecoder().decode(UpdateContract.self, from: Data(contentsOf: url))
  #expect(recorded == computed)
  let all = computed.traces.flatMap { zip($0.events, $0.steps) }
  // The replayed traces reach every kind of step that the theorems name.
  #expect(all.contains { $0.1.read && $0.0.reply == "notModified" })
  #expect(all.contains { $0.0.kind == "check" && !$0.1.read && $0.0.reply != "failed" })
  #expect(all.contains { $0.0.kind == "check" && $0.1.start?.automatic == true })
  #expect(all.contains { $0.0.kind == "check" && $0.1.read && $0.1.waiting != nil })
  #expect(all.contains { $0.0.kind == "path" && $0.1.start?.automatic == true })
  #expect(all.contains { $0.0.kind == "person" && $0.1.start != nil && $0.0.expensive })
}
