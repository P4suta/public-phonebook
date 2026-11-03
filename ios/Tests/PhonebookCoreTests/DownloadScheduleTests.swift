import Testing

@testable import PhonebookCore

@Test func retryDelaysGrowAndThenStayAtFiveMinutes() {
  #expect(
    (1...7).map { DownloadSchedule.retryDelay(afterFailures: $0) } == [
      5, 15, 45, 135, 300, 300, 300,
    ])
  #expect(DownloadSchedule.retryDelay(afterFailures: 0) == 5)
}

@Test func remainingTimeWaitsForEnoughDataAndRoundsUpToFiveSeconds() {
  #expect(DownloadSchedule.remainingSeconds(fraction: 0.04, elapsed: 10) == nil)
  #expect(DownloadSchedule.remainingSeconds(fraction: 0.5, elapsed: 1.9) == nil)
  #expect(DownloadSchedule.remainingSeconds(fraction: .nan, elapsed: 10) == nil)
  // Half the work in 12 seconds leaves 12 seconds, shown as 15.
  #expect(DownloadSchedule.remainingSeconds(fraction: 0.5, elapsed: 12) == 15)
  // A quarter in 30 seconds leaves 90 seconds.
  #expect(DownloadSchedule.remainingSeconds(fraction: 0.25, elapsed: 30) == 90)
  #expect(DownloadSchedule.remainingSeconds(fraction: 0.999, elapsed: 30) == 5)
  #expect(DownloadSchedule.remainingSeconds(fraction: 1, elapsed: 30) == 5)
}

@Test(arguments: 0..<200)
func remainingTimeIsAPositiveMultipleOfFiveAndNeverLessThanThePace(seed: Int) {
  let fraction = 0.05 + Double(seed % 95) / 100
  let elapsed = 2 + Double((seed * 37) % 600)
  guard let seconds = DownloadSchedule.remainingSeconds(fraction: fraction, elapsed: elapsed) else {
    Issue.record("No estimate for \(fraction) after \(elapsed) s")
    return
  }
  #expect(seconds >= 5)
  #expect(seconds % 5 == 0)
  #expect(Double(seconds) >= elapsed * (1 - fraction) / fraction - 1e-9)
  #expect(Double(seconds) < elapsed * (1 - fraction) / fraction + 5 + 1)
}
