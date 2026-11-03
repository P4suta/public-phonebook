import Foundation
import Testing

@testable import PhonebookCore

/// The national archive's bytes and rows when the design was measured.
private let archiveBytes = 13_428_507
private let archiveRows = 667_696
/// Setting this variable to a path writes the contract there instead of comparing it.
private let contractOutput = "PHONEBOOK_WAIT_CONTRACT_OUTPUT"

private struct WaitContract: Codable, Equatable {
  struct Input: Codable, Equatable {
    let now: Int
    let stage: Int
    let done: Int
    let total: Int
    let rows: Int
    let complete: Bool
  }
  struct View: Codable, Equatable {
    let line: String
    let number: Int
    let changedAt: Int
    let shown: Int
    let finished: Bool
    let fast: Bool
  }
  struct Trace: Codable, Equatable {
    let name: String
    let inputs: [Input]
    let views: [View]
  }
  let traces: [Trace]
}

private func sample(
  _ now: Int, _ stage: Int, _ done: Int, _ total: Int, _ rows: Int = archiveRows,
  complete: Bool = false
) -> WaitInput {
  WaitInput(now: now, stage: stage, done: done, total: total, rows: rows, complete: complete)
}

private func lineName(_ line: WaitLine) -> String {
  switch line {
  case .measuring: "measuring"
  case .countdown: "countdown"
  case .longer: "longer"
  case .almostDone: "almostDone"
  case .weakSignal: "weakSignal"
  }
}

/// Runs a trace and records what the screen draws after each sample.
private func views(_ inputs: [WaitInput]) -> [WaitContract.View] {
  var display = WaitDisplay()
  return inputs.map { input in
    display = WaitDisplay.step(display, input)
    return WaitContract.View(
      line: lineName(display.line), number: display.number, changedAt: display.changedAt,
      shown: display.shown, finished: display.finished, fast: display.fast)
  }
}

/// Traces that reach every branch of the policy, including every division and both clamps.
private let traces: [(String, [WaitInput])] = [
  (
    "A Wi-Fi run counts down, follows a faster estimate, and ends after its steps",
    [
      sample(0, 0, 0, 0), sample(300, 0, 0, archiveBytes), sample(900, 0, 3_000_000, archiveBytes),
      sample(1_100, 0, 3_800_000, archiveBytes), sample(2_100, 0, 8_000_000, archiveBytes),
      sample(2_700, 1, 0, archiveRows), sample(3_200, 1, 100_000, archiveRows),
      sample(4_200, 1, 300_000, archiveRows), sample(5_200, 1, 500_000, archiveRows),
      sample(6_000, 2, 0, 1), sample(7_400, 2, 0, 1, complete: true),
    ]
  ),
  (
    "A slow transfer gives coarse minutes and counts down again after a stable short estimate",
    [
      sample(0, 0, 0, 0), sample(200, 0, 0, archiveBytes), sample(1_200, 0, 100_000, archiveBytes),
      sample(2_300, 0, 200_000, archiveBytes), sample(12_000, 0, 12_000_000, archiveBytes),
      sample(13_000, 0, 12_900_000, archiveBytes), sample(15_100, 0, archiveBytes, archiveBytes),
      sample(16_200, 1, 0, archiveRows), sample(17_300, 1, 200_000, archiveRows),
      sample(18_000, 1, 300_000, archiveRows, complete: true),
    ]
  ),
  (
    "A countdown that falls behind its deadline turns into coarse minutes that change slowly",
    [
      sample(0, 0, 0, 0), sample(100, 0, 0, archiveBytes),
      sample(1_100, 0, 5_000_000, archiveBytes),
      sample(2_200, 0, 5_200_000, archiveBytes), sample(3_300, 0, 5_300_000, archiveBytes),
      sample(4_400, 0, 5_400_000, archiveBytes), sample(15_000, 0, 6_000_000, archiveBytes),
      sample(70_000, 0, 6_100_000, archiveBytes),
    ]
  ),
  (
    "A stalled transfer reports a weak signal and measures again once data flows",
    [
      sample(0, 0, 0, 0), sample(100, 0, 0, archiveBytes),
      sample(1_200, 0, 4_000_000, archiveBytes),
      sample(5_000, 0, 4_000_000, archiveBytes), sample(11_300, 0, 4_000_000, archiveBytes),
      sample(13_000, 0, 4_500_000, archiveBytes), sample(14_100, 0, 6_000_000, archiveBytes),
      sample(15_200, 0, 9_000_000, archiveBytes), sample(18_300, 0, archiveBytes, archiveBytes),
    ]
  ),
  (
    "A run that ends at once goes straight to done",
    [
      sample(0, 0, 0, 0, 241), sample(40, 0, 0, 9_000, 241), sample(60, 0, 9_000, 9_000, 241),
      sample(80, 1, 0, 241, 241), sample(120, 2, 0, 1, 241),
      sample(150, 2, 0, 1, 241, complete: true),
    ]
  ),
  (
    "A run predicted to end within the fast time keeps its first screen",
    [
      sample(0, 0, 0, 0, 20_000), sample(100, 0, 0, 200_000, 20_000),
      sample(700, 0, 150_000, 200_000, 20_000), sample(900, 1, 0, 20_000, 20_000),
      sample(1_300, 2, 0, 1, 20_000), sample(1_500, 2, 0, 1, 20_000, complete: true),
    ]
  ),
  (
    "A fast prediction that misses shows the steps, each for its hold",
    [
      sample(0, 0, 0, 0, 20_000), sample(100, 0, 0, 200_000, 20_000),
      sample(700, 0, 150_000, 200_000, 20_000), sample(2_000, 0, 160_000, 200_000, 20_000),
      sample(4_100, 0, 170_000, 200_000, 20_000), sample(4_200, 1, 0, 20_000, 20_000),
      sample(4_900, 1, 10_000, 20_000, 20_000), sample(5_000, 2, 0, 1, 20_000),
      sample(5_300, 2, 0, 1, 20_000, complete: true),
      sample(5_700, 2, 0, 1, 20_000, complete: true),
    ]
  ),
  (
    "Samples outside their ranges clamp, and an older sample changes nothing",
    [
      sample(-50, -1, -5, -10, -3),
      sample(300, 7, 999_999_999_999, 999_999_999_999, 999_999_999_999),
      sample(200, 0, 0, 0, 0),
      sample(1_300, 2, 0, 999_999_999_999, 999_999_999_999),
      sample(99_999_999_999, 2, 0, 999_999_999_999, 999_999_999_999),
      sample(99_999_999_999, 2, 0, 999_999_999_999, 999_999_999_999, complete: true),
    ]
  ),
  (
    "A transfer that stalls after the line said almost done reports a weak signal",
    [
      sample(0, 0, 0, 0, 241), sample(100, 0, 0, 9_000, 241), sample(1_100, 0, 3_000, 9_000, 241),
      sample(6_000, 0, 3_000, 9_000, 241), sample(11_200, 0, 3_000, 9_000, 241),
      sample(12_500, 0, 6_000, 9_000, 241), sample(13_600, 0, 9_000, 9_000, 241),
    ]
  ),
  (
    "Between stages the countdown ticks toward its deadline, and a passed deadline says almost done",
    [
      sample(0, 0, 0, 0), sample(100, 0, 0, archiveBytes),
      sample(1_100, 0, 6_000_000, archiveBytes),
      sample(1_700, 1, 0, archiveRows), sample(2_100, 1, 0, archiveRows),
      sample(12_000, 1, 0, archiveRows),
    ]
  ),
]

/// The Swift policy produces the recorded views, which the Lean model must reproduce in the proof gate.
@Test func everyWaitTraceRefinesTheProofContract() throws {
  let computed = WaitContract(
    traces: traces.map { name, inputs in
      WaitContract.Trace(
        name: name,
        inputs: inputs.map {
          .init(
            now: $0.now, stage: $0.stage, done: $0.done, total: $0.total, rows: $0.rows,
            complete: $0.complete)
        },
        views: views(inputs))
    })
  if let output = ProcessInfo.processInfo.environment[contractOutput] {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    try encoder.encode(computed).write(to: URL(fileURLWithPath: output))
  }
  let url = try #require(Bundle.module.url(forResource: "WaitContract", withExtension: "json"))
  let recorded = try JSONDecoder().decode(WaitContract.self, from: Data(contentsOf: url))
  #expect(recorded == computed)
  let all = computed.traces.flatMap(\.views)
  #expect(
    Set(all.map(\.line)) == ["measuring", "countdown", "longer", "almostDone", "weakSignal"])
  #expect(
    all.contains { $0.fast } && all.contains { $0.finished } && all.contains { $0.shown == 2 })
  let returns = computed.traces.contains { trace in
    zip(trace.views, trace.views.dropFirst()).contains {
      $0.0.line == "longer" && $0.1.line == "countdown"
    }
  }
  #expect(returns)
  for trace in computed.traces { checkPromises(trace.inputs, trace.views, trace.name) }
}

/// Checks the promises of the design on one trace of what the screen draws.
private func checkPromises(
  _ inputs: [WaitContract.Input], _ views: [WaitContract.View], _ name: String
) {
  var countdown = Int.max
  var lineChange = 0
  var stepChange = 0
  var previous = WaitContract.View(
    line: "measuring", number: 0, changedAt: 0, shown: 0, finished: false, fast: false)
  var completed = false
  var latest = 0
  for (input, view) in zip(inputs, views) {
    latest = max(latest, min(max(input.now, 0), WaitDisplay.maximumMilliseconds))
    completed = completed || input.complete
    if view.line == "countdown" {
      #expect(view.number <= countdown, "\(name): the countdown rose")
      #expect(view.number > WaitDisplay.almostSeconds, "\(name): the countdown neared zero")
      countdown = view.number
    }
    if view.line == "longer" { #expect(view.number >= 1, "\(name): zero minutes") }
    if view.line != previous.line || view.number != previous.number {
      #expect(latest - lineChange >= WaitDisplay.lineHoldMs, "\(name): two changes in a second")
      lineChange = latest
    }
    if view.shown != previous.shown {
      #expect(view.shown == previous.shown + 1, "\(name): a step skipped")
      #expect(latest - stepChange >= WaitDisplay.stepHoldMs, "\(name): a step flashed")
      stepChange = latest
    }
    if view.finished { #expect(completed, "\(name): done before the work ended") }
    previous = view
  }
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

@Test func waitPromisesHoldOnSeededRandomTraces() {
  var random = SplitMix(state: 20_261_104)
  var checked = 0
  for _ in 0..<2_000 {
    var inputs: [WaitInput] = []
    var now = 0
    var stage = 0
    var done = 0
    let bytes = 1 + random.next(archiveBytes)
    let rows = 1 + random.next(archiveRows)
    for index in 0..<40 {
      now += random.next(3) == 0 ? random.next(12_000) : random.next(1_500)
      if random.next(8) == 0, stage < WaitDisplay.lastStage {
        stage += 1
        done = 0
      }
      let total = stage == 0 ? bytes : stage == 1 ? rows : 1
      if random.next(4) != 0 { done = min(total, done + random.next(max(total / 6, 1))) }
      let older = random.next(20) == 0 ? -random.next(2_000) : 0
      inputs.append(
        sample(now + older, stage, done, total, rows, complete: index == 39 || random.next(60) == 0)
      )
    }
    let recorded = views(inputs)
    checkPromises(
      inputs.map {
        .init(
          now: $0.now, stage: $0.stage, done: $0.done, total: $0.total, rows: $0.rows,
          complete: $0.complete)
      }, recorded, "seeded trace \(checked)")
    checked += 1
  }
  #expect(checked == 2_000)
}

/// Every product in the estimate stays within Int64 at the clamped extremes, where a trap would end the test.
@Test func waitArithmeticStaysWithinInt64AtTheClampedExtremes() {
  for stage in 0...1 {
    var display = WaitDisplay()
    display = WaitDisplay.step(display, sample(0, stage, 0, .max, .max))
    display = WaitDisplay.step(display, sample(.max, stage, 1, .max, .max))
    #expect(display.now == WaitDisplay.maximumMilliseconds)
    #expect(display.line == .longer)
    #expect(display.minutes >= 1)
  }
  var display = WaitDisplay()
  display = WaitDisplay.step(display, sample(.min, .min, .min, .min, .min, complete: false))
  #expect(display.now == 0 && display.stage == 0 && display.total == 0)
}
