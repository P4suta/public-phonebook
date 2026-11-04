import Foundation

/// The search tiers: a one-word query's exact, prefix, and substring name matches, then rows that match through their region or category.
public enum NameRank: Int, CaseIterable, Comparable, Sendable {
  case exact, prefix, substring, place

  public static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
}

public enum SearchInput {
  public static let maximumPhoneLength = 80
  public static let maximumQueryBytes = 512
  /// The most words that one name query may hold, the same limit as the website's.
  public static let maximumQueryWords = 8

  public static func normalizedName(_ text: String) -> String {
    text.precomposedStringWithCompatibilityMapping.lowercased()
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// Folds the input variants that search ignores, the same way as the website's `foldSearchCharacters`.
  /// Compatibility composition and lowercase come first.
  /// Katakana then become hiragana, small ヵ and ヶ become か and け, and every long-vowel and dash mark becomes a hyphen-minus.
  /// Canonical composition last joins a folded small kana with a following voiced mark, so folding twice changes nothing.
  public static func foldedCharacters(_ text: String) -> String {
    var scalars = String.UnicodeScalarView()
    for scalar in text.precomposedStringWithCompatibilityMapping.lowercased().unicodeScalars {
      scalars.append(foldedScalars[scalar] ?? scalar)
    }
    return String(scalars).precomposedStringWithCanonicalMapping
  }

  /// Splits text into the folded words that search compares, at runs of any Unicode whitespace.
  public static func words(_ text: String) -> [String] {
    foldedCharacters(text).unicodeScalars.split(whereSeparator: \.properties.isWhitespace).map {
      String(String.UnicodeScalarView($0))
    }
  }

  /// The comparison form of a name, region, or label: its folded words joined by one space.
  public static func searchForm(_ text: String) -> String {
    words(text).joined(separator: " ")
  }

  /// Ranks a row from how many of the query's words its name holds and how many of the rest its region or category holds.
  /// It mirrors the website's proved `wordRank`, and only a one-word query that the name holds reads `nameRank`.
  public static func wordRank(words: Int, named: Int, placed: Int, nameRank: NameRank) -> NameRank?
  {
    if named + placed < words { return nil }
    if named < words { return .place }
    return words == 1 ? nameRank : .substring
  }

  /// Ranks a comparison name against folded words, or returns nil when a word occurs neither in the name nor, by `placed`, in the row's region or category.
  public static func rank(name: String, words: [String], placed: (Int) -> Bool) -> NameRank? {
    guard let single = words.first else { return nil }
    var named = 0
    var inPlaces = 0
    for (index, word) in words.enumerated() {
      if name.utf8.firstRange(of: word.utf8) != nil {
        named += 1
      } else if placed(index) {
        inPlaces += 1
      } else {
        return nil
      }
    }
    let nameRank: NameRank =
      name.utf8.elementsEqual(single.utf8)
      ? .exact : name.utf8.starts(with: single.utf8) ? .prefix : .substring
    return wordRank(words: words.count, named: named, placed: inPlaces, nameRank: nameRank)
  }

  private static let foldedScalars: [Unicode.Scalar: Unicode.Scalar] = {
    var folds: [Unicode.Scalar: Unicode.Scalar] = [:]
    func scalar(_ value: UInt32) -> Unicode.Scalar { Unicode.Scalar(value) ?? "\u{FFFD}" }
    for value in UInt32(0x30A1)...0x30F6 { folds[scalar(value)] = scalar(value - 0x60) }
    for value in [UInt32(0x30FD), 0x30FE] { folds[scalar(value)] = scalar(value - 0x60) }
    for small in ["ゕ", "ヵ"] as [Unicode.Scalar] { folds[small] = "か" }
    for small in ["ゖ", "ヶ"] as [Unicode.Scalar] { folds[small] = "け" }
    for dash in "ーｰ‐‑‒–—―−﹣－".unicodeScalars { folds[dash] = "-" }
    return folds
  }()

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
    // One group equal to the domestic number joins to that number, so the hyphenated form needs no group count.
    return groups.joined() == domestic ? groups.joined(separator: "-") : domestic
  }

  private static let telephoneScalars = Set(
    "0123456789０１２３４５６７８９+＋()（）.． \t\u{00a0}\u{3000}-－‐‑‒–—―−⁻₋﹣ーｰ".unicodeScalars)
  private static let compactedSeparators = Set(" \t().-‐‑‒–—―−ー".unicodeScalars)

  private static func isTelephoneSpelling(_ text: String) -> Bool {
    !text.isEmpty && text.unicodeScalars.allSatisfy(telephoneScalars.contains)
  }
}
