import Foundation

public enum RefreshPolicy {
  /// The background processing task's earliest date, a month after the saved snapshot was generated.
  /// A bundled snapshot older than a month is therefore due at once, and an unreadable date counts from the time of saving.
  public static func nextDate(generatedAt: String, savedAt: Date, lastAttempt: Date?) -> Date {
    nextDate(updatedAt: generated(generatedAt) ?? savedAt, lastAttempt: lastAttempt)
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
