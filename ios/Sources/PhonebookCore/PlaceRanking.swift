import Foundation

struct RankingCondition: Sendable {
  let word: String
  var prefectures: Set<String> = []
  var municipalities: Set<String> = []
}

struct PlaceRanking: Sendable {
  let dictionary: [String: RankingCondition]
  let order: [String]

  init(_ places: [RankingPlace]) {
    var dictionary: [String: RankingCondition] = [:]
    var order: [String] = []
    for place in places {
      let name = RankingText.compact(place.name)
      let ward = Self.capture("[市郡]([^市郡]+区)$", in: name)
      let city = Self.capture("^(.+?市).+区$", in: name)
      let words = [
        name, Self.removingSuffix(name, from: "都府県市区町村"), ward,
        ward.map { Self.removingSuffix($0, from: "区") }, city,
        city.map { Self.removingSuffix($0, from: "市") },
      ]
      var seen = Set<String>()
      for word in words.compactMap({ $0 }) where !word.isEmpty && seen.insert(word).inserted {
        if dictionary[word] == nil {
          dictionary[word] = RankingCondition(word: word)
          order.append(word)
        }
        if place.prefecture {
          dictionary[word]?.prefectures.insert(place.code)
        } else {
          dictionary[word]?.municipalities.insert(place.code)
        }
      }
    }
    self.dictionary = dictionary
    self.order = order
  }

  private static func removingSuffix(_ word: String, from suffixes: String) -> String {
    guard let last = word.unicodeScalars.last, suffixes.unicodeScalars.contains(last) else {
      return word
    }
    return String(word.unicodeScalars.dropLast())
  }

  private static func capture(_ pattern: String, in text: String) -> String? {
    guard let regex = try? NSRegularExpression(pattern: pattern),
      let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
      let range = Range(match.range(at: 1), in: text)
    else { return nil }
    return String(text[range])
  }

  func parse(_ query: String) -> (stripped: String, conditions: [RankingCondition]) {
    let words = SearchInput.words(query)
    let remaining = words.filter { dictionary[RankingText.compact($0)] == nil }
    if remaining.isEmpty { return (query, []) }
    return (
      remaining.joined(separator: " "), words.compactMap { dictionary[RankingText.compact($0)] }
    )
  }

  func tied(_ query: String) -> [RankingCondition] {
    let compact = RankingText.compact(query)
    return order.compactMap { dictionary[$0] }.filter {
      $0.word.utf16.count >= 2 && compact.hasPrefix($0.word)
    }.sorted { $0.word.utf16.count > $1.word.utf16.count }.prefix(1).map { $0 }
  }

  static func matches(_ row: RankingRow, conditions: [RankingCondition]) -> Bool {
    let literal = RankingText.compact(row.name)
    return conditions.allSatisfy {
      $0.prefectures.contains(String(row.region.prefix(2)))
        || $0.municipalities.contains(row.region)
        || literal.contains($0.word)
    }
  }
}
