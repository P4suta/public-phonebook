import Testing

@testable import PhonebookCore

private func input(
  _ now: Int, _ stage: Int, _ done: Int, _ total: Int, rows: Int = 0, complete: Bool = false
) -> WaitInput {
  WaitInput(now: now, stage: stage, done: done, total: total, rows: rows, complete: complete)
}

private func run(_ inputs: [WaitInput]) -> WaitDisplay {
  inputs.reduce(WaitDisplay()) { WaitDisplay.step($0, $1) }
}

/// A 9 s countdown shown at 1.1 s with its deadline at 10.1 s.
private let nineSeconds = run([
  input(0, 0, 0, 0), input(100, 0, 0, 1_000_000), input(1_100, 0, 100_000, 1_000_000),
])

/// The same run after a slower piece at 2.2 s, which turns the countdown into one coarse minute.
private let oneMinute = WaitDisplay.step(nineSeconds, input(2_200, 0, 110_000, 1_000_000))

/// A tracked copy of `display` whose last progress is `now`, so no stall decides the line.
private func moving(_ display: WaitDisplay, at now: Int, stableSince: Int = -1) -> WaitDisplay {
  var tracked = display
  tracked.progressAt = now
  tracked.stableSince = stableSince
  return tracked
}

@Test func waitTracesReachTheirStartingDisplays() {
  #expect(nineSeconds.line == .countdown && nineSeconds.number == 9)
  #expect(nineSeconds.deadline == 10_100 && nineSeconds.changedAt == 1_100)
  #expect(oneMinute.line == .longer && oneMinute.number == 1 && oneMinute.seconds == 9)
  #expect(oneMinute.changedAt == 2_200)
}

@Test func waitSecondsRoundUpAtWholeSeconds() {
  #expect(WaitDisplay.ceilSeconds(0) == 0)
  #expect(WaitDisplay.ceilSeconds(1) == 1)
  #expect(WaitDisplay.ceilSeconds(1_000) == 1)
  #expect(WaitDisplay.ceilSeconds(1_001) == 2)
}

@Test func theLastStepTakesItsBudgetOnlyWhenItStarts() {
  var preparing = WaitDisplay()
  preparing.stage = 1
  preparing.total = 10
  preparing.identifyBudget = 4_000
  let entered = WaitDisplay.track(preparing, 1_000, 2, 0, 1, 1_000_000)
  #expect(entered.identifyEnd == 5_000)
  var identifying = entered
  identifying.identifyEnd = 9_000
  #expect(WaitDisplay.track(identifying, 2_000, 2, 0, 7, 0).identifyEnd == 9_000)
}

@Test func theEstimateFollowsTheMeasuredPaceAndItsIdleTime() {
  var transfer = WaitDisplay()
  transfer.progressAt = 1_000
  transfer.baseDone = 100
  transfer.lastDone = 200
  #expect(WaitDisplay.remaining(transfer, 1_000, 1_000, 0) == 8_000)
  #expect(WaitDisplay.remaining(transfer, 1_000, 0, 0) == -1)
  var unmoved = transfer
  unmoved.lastDone = 100
  #expect(WaitDisplay.remaining(unmoved, 1_000, 1_000, 0) == -1)
  var preparing = transfer
  preparing.stage = 1
  preparing.baseDone = 0
  preparing.lastDone = 100
  #expect(WaitDisplay.remaining(preparing, 3_000, 1_000, 0) == 9_000 + 4_285 - 2_000)
}

@Test func theLastStepBudgetAndTheFastMarkMeetTheirBoundaries() {
  var preparing = WaitDisplay()
  preparing.stage = 1
  preparing.total = 1_000
  preparing.baseAt = 200
  preparing.progressAt = 1_200
  preparing.baseDone = 100
  preparing.lastDone = 200
  #expect(WaitDisplay.refine(WaitDisplay(), preparing, 1_200, 0).identifyBudget == 4_285)
  #expect(WaitDisplay.refine(WaitDisplay(), WaitDisplay(), 1_000, 1_000).fast)
  #expect(!WaitDisplay.refine(WaitDisplay(), WaitDisplay(), 1_000, 1_001).fast)
  let fast = run([
    input(0, 0, 0, 0, rows: 20_000), input(100, 0, 0, 200_000, rows: 20_000),
    input(700, 0, 150_000, 200_000, rows: 20_000),
  ])
  #expect(fast.fast)
  #expect(WaitDisplay.step(fast, input(4_000, 0, 150_000, 200_000, rows: 20_000)).fast)
  #expect(!WaitDisplay.step(fast, input(4_001, 0, 150_000, 200_000, rows: 20_000)).fast)
}

@Test func aStepAdvancesOnceItsHoldPasses() {
  let start = WaitDisplay()
  #expect(WaitDisplay.advance(start, start, 600, 1).shown == 1)
  #expect(WaitDisplay.advance(start, start, 599, 1).shown == 0)
}

@Test func theLineChoicesMeetTheirBoundaries() {
  let start = WaitDisplay()
  #expect(WaitDisplay.choose(start, start, 10_000, -1, 0).line == .weakSignal)
  #expect(WaitDisplay.choose(start, start, 9_999, -1, 0).line == .measuring)
  let short = WaitDisplay.choose(start, moving(start, at: 1_000), 1_000, 60_000, 0)
  #expect(short.line == .countdown && short.seconds == 60)
  #expect(WaitDisplay.choose(start, moving(start, at: 1_000), 1_000, 60_001, 0).line == .longer)
}

@Test func aCountdownTurnsLongerOnlyPastItsSlackAndTheShortTime() {
  let behind = WaitDisplay.choose(nineSeconds, moving(nineSeconds, at: 2_000), 2_000, 11_100, 0)
  #expect(behind.line == .countdown && behind.seconds == 9)
  #expect(
    WaitDisplay.choose(nineSeconds, moving(nineSeconds, at: 2_000), 2_000, 11_101, 0).line
      == .longer)
  let fiftyNine = run([
    input(0, 0, 0, 0), input(100, 0, 0, 600_000), input(1_100, 0, 10_000, 600_000),
  ])
  #expect(fiftyNine.line == .countdown && fiftyNine.number == 59)
  #expect(
    WaitDisplay.choose(fiftyNine, moving(fiftyNine, at: 1_200), 1_200, 60_000, 0).line
      == .countdown)
}

@Test func coarseMinutesChangeOnlyAfterTheirHold() {
  #expect(
    WaitDisplay.choose(oneMinute, moving(oneMinute, at: 12_200), 12_200, 200_000, 0).minutes
      == 3)
  #expect(
    WaitDisplay.choose(oneMinute, moving(oneMinute, at: 8_000), 8_000, 200_000, 0).minutes == 1)
}

@Test func coarseMinutesCountDownAgainOnlyAfterAStableShortEstimate() {
  let stable = moving(oneMinute, at: 3_300, stableSince: 0)
  let returned = WaitDisplay.choose(oneMinute, stable, 3_300, 9_000, 0)
  #expect(returned.line == .countdown && returned.seconds == 9)
  let held = WaitDisplay.choose(
    oneMinute, moving(oneMinute, at: 3_300, stableSince: 300), 3_300, 9_000, 0)
  #expect(held.line == .countdown)
  let waiting = WaitDisplay.choose(
    oneMinute, moving(oneMinute, at: 2_500, stableSince: 0), 2_500, 9_000, 0)
  #expect(waiting.line == .longer && waiting.stableSince == 0)
}

@Test func aFinishedDisplayAndAnOlderSampleChangeNothing() {
  let finished = run([
    input(0, 0, 0, 0), input(100, 0, 0, 9_000), input(150, 2, 0, 1, complete: true),
  ])
  #expect(finished.finished)
  #expect(WaitDisplay.step(finished, input(5_000, 2, 0, 1)) == finished)
  #expect(WaitDisplay.step(nineSeconds, input(1_000, 0, 200_000, 1_000_000)) == nineSeconds)
}

@Test func theDoneStateWaitsForTheLastStepHold() {
  let rows = 1_000_000
  let late = run([
    input(0, 0, 0, 0, rows: rows), input(100, 1, 0, 10, rows: rows),
    input(600, 1, 0, 10, rows: rows), input(1_500, 2, 0, 1, rows: rows),
    input(2_000, 2, 0, 1, rows: rows, complete: true),
  ])
  #expect(late.shownAt == 1_500 && !late.fast && late.finished)
  let held = run([
    input(0, 0, 0, 0, rows: rows), input(100, 1, 0, 10, rows: rows),
    input(600, 1, 0, 10, rows: rows), input(2_400, 2, 0, 1, rows: rows),
    input(3_000, 2, 0, 1, rows: rows, complete: true),
  ])
  #expect(held.shownAt == 2_400 && !held.fast && held.finished)
  let small = 100_000
  let fast = run([
    input(0, 0, 0, 0, rows: small), input(100, 1, 0, 10, rows: small),
    input(1_450, 1, 0, 10, rows: small), input(1_500, 2, 0, 1, rows: small),
    input(2_010, 2, 0, 1, rows: small, complete: true),
  ])
  #expect(fast.shownAt == 1_450 && fast.fast && fast.finished)
}
