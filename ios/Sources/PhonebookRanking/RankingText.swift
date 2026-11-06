import Foundation
import PhonebookCore

public enum RankingText {
  public static func compact(_ text: String) -> String {
    String(
      String.UnicodeScalarView(
        SearchInput.foldedCharacters(text).unicodeScalars.filter {
          !$0.properties.isWhitespace
        }))
  }

  static func name(_ text: String, variants: [String: String]) -> String {
    compact(text).precomposedStringWithCanonicalMapping.unicodeScalars.map {
      variants[String($0)] ?? String($0)
    }.joined()
  }

  static func original(_ text: String) -> String {
    let normalized = text.precomposedStringWithCompatibilityMapping.lowercased()
    return String(
      String.UnicodeScalarView(
        normalized.unicodeScalars.filter {
          !$0.properties.isWhitespace
        })
    ).precomposedStringWithCanonicalMapping
  }

  public static func grams(_ text: String, width: Int) -> [String] {
    let points = Array(text.unicodeScalars)
    guard width > 0 else { return [] }
    guard points.count >= width else { return points.isEmpty ? [] : [text] }
    var seen = Set<String>()
    var result: [String] = []
    for position in 0...(points.count - width) {
      let gram = String(String.UnicodeScalarView(points[position..<(position + width)]))
      if seen.insert(gram).inserted { result.append(gram) }
    }
    return result
  }

  public static func precedes(_ left: String, _ right: String) -> Bool {
    left.utf16.lexicographicallyPrecedes(right.utf16)
  }

  static func hasHan(_ text: String) -> Bool {
    text.range(of: "\\p{sc=Han}", options: .regularExpression) != nil
  }

  static func kanaCount(_ text: String) -> Int {
    text.unicodeScalars.filter {
      String($0).range(of: "[\\p{sc=Hiragana}\\p{sc=Katakana}]", options: .regularExpression) != nil
    }.count
  }
}
