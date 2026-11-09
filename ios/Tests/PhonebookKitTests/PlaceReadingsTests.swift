import Foundation
import PhonebookCore
import Testing

@testable import PhonebookKit

private struct PlaceReadingCase: Decodable {
  let text: String
  let prefectures: [String]
  let categories: [String]
}

@Test func sharedPlaceReadingContract() throws {
  let url = try #require(
    Bundle.module.url(forResource: "PlaceReadingContract", withExtension: "json"))
  let cases = try JSONDecoder().decode([PlaceReadingCase].self, from: Data(contentsOf: url))
  let readings = try BundledPlaceReadings.load()
  for row in cases {
    let result = readings.matching(SearchInput.searchForm(row.text))
    #expect(result.prefectures == row.prefectures, "\(row.text)")
    #expect(result.categories == row.categories, "\(row.text)")
  }
}

@Test func malformedPlaceReadingsAreRejected() throws {
  let prefectures = Array(repeating: "トウキョウト", count: 47)
  #expect(throws: PlaceReadings.InvalidData.self) {
    try PlaceReadings(prefectures: Array(prefectures.dropFirst()), categories: [:])
  }
  for aliases in [[], ["ト"], ["図書館"], Array(repeating: "トショカン", count: 9)] {
    #expect(throws: PlaceReadings.InvalidData.self) {
      try PlaceReadings(prefectures: prefectures, categories: ["library": aliases])
    }
  }
  #expect(throws: PlaceReadings.InvalidData.self) {
    try PlaceReadings(prefectures: prefectures, categories: ["library|medical": ["トショカン"]])
  }
}
