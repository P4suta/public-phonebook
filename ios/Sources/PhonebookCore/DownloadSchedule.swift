import Foundation

/// Decides when the app retries a failed download and how it states the download's size.
public enum DownloadSchedule {
  /// The retry delays in seconds, after which every retry waits the last one.
  public static let retryDelays = [5, 15, 45, 135, 300]

  /// Seconds to wait before the automatic retry that follows `failures` consecutive failures.
  public static func retryDelay(afterFailures failures: Int) -> Int {
    retryDelays[min(max(failures, 1), retryDelays.count) - 1]
  }

  /// The national archive's listed length on 2026-11-04, for the welcome notice when the listing is out of reach.
  public static let knownArchiveBytes = 13_428_507
  static let bytesPerMegabyte = 1_000_000

  /// Whole megabytes rounded up, so the notice never understates the data a download spends.
  public static func megabytes(_ bytes: Int) -> Int {
    max(1, (max(bytes, 0) + bytesPerMegabyte - 1) / bytesPerMegabyte)
  }
}
