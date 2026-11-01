import Foundation

public enum RefreshPolicy {
  public static func nextDate(updatedAt: Date, lastAttempt: Date?) -> Date {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = .gmt
    let monthly =
      calendar.date(byAdding: .month, value: 1, to: updatedAt)
      ?? updatedAt.addingTimeInterval(31 * 86_400)
    return max(monthly, lastAttempt?.addingTimeInterval(86_400) ?? monthly)
  }
}
