import Testing

@testable import PhonebookCore

@Test func retryDelaysGrowAndThenStayAtFiveMinutes() {
  #expect(
    (1...7).map { DownloadSchedule.retryDelay(afterFailures: $0) } == [
      5, 15, 45, 135, 300, 300, 300,
    ])
  #expect(DownloadSchedule.retryDelay(afterFailures: 0) == 5)
}

@Test func downloadSizesRoundUpToWholeMegabytesFromOneMegabyte() {
  #expect(DownloadSchedule.megabytes(DownloadSchedule.knownArchiveBytes) == "14")
  #expect(DownloadSchedule.megabytes(13_000_000) == "13")
  #expect(DownloadSchedule.megabytes(13_000_001) == "14")
  #expect(DownloadSchedule.megabytes(1_000_000) == "1")
  #expect(DownloadSchedule.megabytes(1_000_001) == "2")
}

@Test func downloadSizesUnderOneMegabyteRoundUpToATenth() {
  #expect(DownloadSchedule.megabytes(374_905) == "0.4")
  #expect(DownloadSchedule.megabytes(1) == "0.1")
  #expect(DownloadSchedule.megabytes(100_000) == "0.1")
  #expect(DownloadSchedule.megabytes(100_001) == "0.2")
  #expect(DownloadSchedule.megabytes(900_001) == "1")
  #expect(DownloadSchedule.megabytes(999_999) == "1")
  #expect(DownloadSchedule.megabytes(0) == "0.1")
  #expect(DownloadSchedule.megabytes(-5) == "0.1")
}
