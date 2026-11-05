import Testing

@testable import PhonebookCore

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
