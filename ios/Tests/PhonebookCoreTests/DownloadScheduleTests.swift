import Testing

@testable import PhonebookCore

@Test func retryDelaysGrowAndThenStayAtFiveMinutes() {
  #expect(
    (1...7).map { DownloadSchedule.retryDelay(afterFailures: $0) } == [
      5, 15, 45, 135, 300, 300, 300,
    ])
  #expect(DownloadSchedule.retryDelay(afterFailures: 0) == 5)
}

@Test func downloadSizesRoundUpToWholeMegabytes() {
  #expect(DownloadSchedule.megabytes(DownloadSchedule.knownArchiveBytes) == 14)
  #expect(DownloadSchedule.megabytes(13_000_000) == 13)
  #expect(DownloadSchedule.megabytes(13_000_001) == 14)
  #expect(DownloadSchedule.megabytes(9_000) == 1)
  #expect(DownloadSchedule.megabytes(0) == 1)
  #expect(DownloadSchedule.megabytes(-5) == 1)
}
