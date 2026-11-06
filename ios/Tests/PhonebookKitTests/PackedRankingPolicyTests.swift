import Foundation
import Testing

@testable import PhonebookRanking

private func packedWords(_ words: [UInt32]) -> PackedBytes {
  var data = Data()
  for word in words {
    var value = word.littleEndian
    withUnsafeBytes(of: &value) { data.append(contentsOf: $0) }
  }
  return PackedBytes(data: data, range: 0..<data.count)
}

@Test func packedLexiconPrefixesUseScalarBoundaries() throws {
  let surface = RankingText.compact("x\u{30a}")
  let reading = "r"
  let data = Data((surface + reading).utf8)
  let dictionary = PackedDictionary(
    table: packedWords([0, 0, 1]), values: packedWords([1]),
    strings: PackedBytes(data: data, range: 0..<data.count),
    offsets: packedWords([0, UInt32(surface.utf8.count), UInt32(data.count)]), weights: nil,
    fixed: true)
  try dictionary.validate(stringCount: 2, maximum: 2)
  #expect(dictionary.choices("x") == [])
  #expect(dictionary.choices(surface) == [reading])
}

@Test func packedReadingOverlapPreservesScalarGramsInsideGraphemeClusters() {
  let names = [
    "", "a", "abc", "図書館", "図書館図書館", "\u{915}\u{94d}\u{937}abc", "🇯🇵abc",
    "👨\u{200d}👩\u{200d}👧\u{200d}👦abc", "éabc", "a\u{301}bc", "x\u{600}abc",
    "x\u{93e}abc",
  ].map(RankingText.compact)
  let queries = names.flatMap { RankingText.grams($0, width: 3) } + names
  for name in names {
    let grams = RankingText.grams(name, width: 3)
    let own = Set(grams)
    for text in queries {
      let query = RankingText.grams(RankingText.compact(text), width: 3)
      let expected = RankingPolicy.dice(
        shared: Int64(query.filter(own.contains).count), query: Int64(query.count),
        name: Int64(grams.count))
      #expect(
        ReadingRanking.packedDice(query, name, count: grams.count) == expected,
        "Scalar overlap differs for \(text) in \(name)")
    }
  }
}
