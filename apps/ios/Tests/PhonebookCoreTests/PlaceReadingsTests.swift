import Foundation
import Testing

@testable import PhonebookCore

private let prefectureReadings = Array(repeating: "アア", count: 47)

@Test func placeReadingsMatchPrefixesWithCanonicalCodesAndSortedCategories() throws {
  let readings = try PlaceReadings(
    prefectures: prefectureReadings, categories: ["beta": ["イイ", "アア"], "alpha": ["アア"]])
  let matches = readings.matching("ああ")
  #expect(matches.prefectures.count == 47)
  #expect(matches.prefectures.first == "01")
  #expect(matches.prefectures.last == "47")
  #expect(matches.categories == ["alpha", "beta"])
  #expect(readings.matching("いい").categories == ["beta"])
  for word in ["あ", "a", "--", "あa", "いう"] {
    #expect(readings.matching(word) == PlaceReadings.Matches(prefectures: [], categories: []))
  }
}

@Test func placeReadingsRejectEachMalformedInputIndependently() throws {
  for count in [0, 1, 46, 48] {
    #expect(throws: PlaceReadings.InvalidData.self) {
      try PlaceReadings(prefectures: Array(repeating: "アア", count: count), categories: [:])
    }
  }
  for value in ["", "ア", String(repeating: "ア", count: 129), "ああ", "アa", "ア😀"] {
    var prefectures = prefectureReadings
    prefectures[0] = value
    #expect(throws: PlaceReadings.InvalidData.self) {
      try PlaceReadings(prefectures: prefectures, categories: [:])
    }
    #expect(throws: PlaceReadings.InvalidData.self) {
      try PlaceReadings(prefectures: prefectureReadings, categories: ["alpha": [value]])
    }
  }
  for aliases in [[], Array(repeating: "アア", count: 9)] {
    #expect(throws: PlaceReadings.InvalidData.self) {
      try PlaceReadings(prefectures: prefectureReadings, categories: ["alpha": aliases])
    }
  }
  for key in ["", "Alpha", "1alpha", "alpha|beta", String(repeating: "a", count: 65)] {
    #expect(throws: PlaceReadings.InvalidData.self) {
      try PlaceReadings(prefectures: prefectureReadings, categories: [key: ["アア"]])
    }
  }
}

@Test func placeReadingsAcceptTheirClosedLengthAndKanaBounds() throws {
  for value in ["ァヶ", "アー", String(repeating: "ア", count: 128)] {
    _ = try PlaceReadings(
      prefectures: Array(repeating: value, count: 47),
      categories: [String(repeating: "a", count: 64): Array(repeating: value, count: 8)])
  }
  let readings = try PlaceReadings(
    prefectures: Array(repeating: "アー", count: 47), categories: ["alpha": ["アー"]])
  #expect(readings.matching("あ-").prefectures.count == 47)
  #expect(readings.matching("あ-").categories == ["alpha"])
}

@Test func readingQueriesRequireTwoScalarsAndUseOnlyHiraganaAndHyphens() {
  for value in ["ああ", "あ-", "-あ", "\u{3041}\u{3096}", "\u{309D}-", "\u{309E}-"] {
    #expect(PlaceReadings.admits(value))
  }
  for value in ["", "あ", "--", "aa", "あa", "あア", "あ\u{3040}", "あ\u{3097}"] {
    #expect(!PlaceReadings.admits(value))
  }
}
