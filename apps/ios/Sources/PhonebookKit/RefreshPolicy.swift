import Foundation

public enum RefreshPolicy {
  /// The background processing task's earliest date, a month after the saved snapshot was generated.
  /// A bundled snapshot older than a month is therefore due at once, and an unreadable date counts from the time of saving.
  public static func nextDate(generatedAt: String, savedAt: Date, lastAttempt: Date?) -> Date {
    nextDate(
      updatedAt: dataDate(generatedAt: generatedAt, savedAt: savedAt), lastAttempt: lastAttempt)
  }

  /// The date that the screens give the data: when the snapshot was generated, or when it was saved if that date is unreadable.
  /// A bundled snapshot saved today keeps the date of its generation.
  public static func dataDate(generatedAt: String, savedAt: Date) -> Date {
    generated(generatedAt) ?? savedAt
  }

  /// Reads the archive header's `generatedAt`, which production writes with milliseconds and the fixture without.
  static func generated(_ text: String) -> Date? {
    (try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
      ?? (try? Date(text, strategy: .iso8601))
  }

  public static func nextDate(updatedAt: Date, lastAttempt: Date?) -> Date {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = .gmt
    let monthly =
      calendar.date(byAdding: .month, value: 1, to: updatedAt)
      ?? updatedAt.addingTimeInterval(31 * 86_400)
    return max(monthly, lastAttempt?.addingTimeInterval(86_400) ?? monthly)
  }
}

extension SnapshotManifest {
  /// The date that the screens give the saved data.
  public var dataDate: Date { RefreshPolicy.dataDate(generatedAt: generatedAt, savedAt: updatedAt) }
}
