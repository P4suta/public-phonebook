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
  static let bytesPerTenth = 100_000
  static let tenthsPerMegabyte = 10

  /// The megabytes that the welcome notice names, rounded up so the notice never understates the data a transfer spends.
  /// A size that rounds up to less than 1 MB keeps one decimal, and a larger size names whole megabytes.
  public static func megabytes(_ bytes: Int) -> String {
    let counted = max(bytes, 0)
    let tenths = max(1, (counted + bytesPerTenth - 1) / bytesPerTenth)
    guard tenths >= tenthsPerMegabyte else { return "0.\(tenths)" }
    return String((counted + bytesPerMegabyte - 1) / bytesPerMegabyte)
  }
}
