import Foundation

/// Decides when the app retries a failed download and how long a running download has left.
public enum DownloadSchedule {
  /// The retry delays in seconds, after which every retry waits the last one.
  public static let retryDelays = [5, 15, 45, 135, 300]

  /// Seconds to wait before the automatic retry that follows `failures` consecutive failures.
  public static func retryDelay(afterFailures failures: Int) -> Int {
    retryDelays[min(max(failures, 1), retryDelays.count) - 1]
  }

  /// The estimate needs this share of the work and this many seconds before it means anything.
  static let minimumFraction = 0.05
  static let minimumElapsed = 2.0
  /// Estimates round up to this many seconds, so the number changes calmly.
  static let step = 5

  /// Seconds left for a download that finished `fraction` of its work in `elapsed` seconds, at the same pace.
  /// Returns nil until the estimate has enough data, and never less than one step.
  public static func remainingSeconds(fraction: Double, elapsed: Double) -> Int? {
    guard fraction.isFinite, elapsed.isFinite, fraction >= minimumFraction,
      elapsed >= minimumElapsed
    else { return nil }
    guard fraction < 1 else { return step }
    let seconds = elapsed * (1 - fraction) / fraction
    guard seconds < Double(Int.max / 2) else { return nil }
    let rounded = (Int(seconds.rounded(.up)) + step - 1) / step * step
    return max(rounded, step)
  }
}
