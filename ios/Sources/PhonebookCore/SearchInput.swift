import Foundation

public enum NameRank: Int, CaseIterable, Comparable, Sendable {
  case exact, prefix, substring

  public static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
}

public enum SearchInput {
  public static let maximumPhoneLength = 80
  public static let maximumQueryBytes = 512

  public static func normalizedName(_ text: String) -> String {
    text.precomposedStringWithCompatibilityMapping.lowercased()
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  public static func rank(name: String, query: String) -> NameRank? {
    guard !query.isEmpty else { return nil }
    if name == query { return .exact }
    if name.hasPrefix(query) { return .prefix }
    return name.contains(query) ? .substring : nil
  }

  public static func normalizedPhone(_ input: String) -> String? {
    let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard text.utf16.count <= maximumPhoneLength, isTelephoneSpelling(text) else { return nil }
    let compact = String(
      String.UnicodeScalarView(
        text.precomposedStringWithCompatibilityMapping.unicodeScalars.filter {
          !compactedSeparators.contains($0)
        }))
    let domestic = compact.hasPrefix("+81") ? "0" + compact.dropFirst(3) : compact
    let digits = Array(domestic.utf8)
    guard (10...11).contains(digits.count), digits[0] == 48, (49...57).contains(digits[1]),
      digits.allSatisfy({ (48...57).contains($0) })
    else { return nil }
    return "+81" + domestic.dropFirst()
  }

  public static func nationalDisplay(_ display: String, e164: String) -> String {
    let domestic = "0" + e164.dropFirst(3)
    let normalized = display.precomposedStringWithCompatibilityMapping
    var groups = normalized.split { !($0.isASCII && $0.isNumber) }.map(String.init)
    if normalized.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("+"),
      groups.first == "81", groups.count > 1
    {
      groups.removeFirst()
      groups[0] = "0" + groups[0]
    }
    return groups.count > 1 && groups.joined() == domestic
      ? groups.joined(separator: "-") : domestic
  }

  private static let telephoneScalars = Set(
    "0123456789０１２３４５６７８９+＋()（）.． \t\u{00a0}\u{3000}-－‐‑‒–—―−⁻₋﹣ーｰ".unicodeScalars)
  private static let compactedSeparators = Set(" \t().-‐‑‒–—―−ー".unicodeScalars)

  private static func isTelephoneSpelling(_ text: String) -> Bool {
    !text.isEmpty && text.unicodeScalars.allSatisfy(telephoneScalars.contains)
  }
}
