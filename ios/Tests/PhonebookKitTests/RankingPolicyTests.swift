import Testing

@testable import PhonebookRanking

@Test func rankingScoreBandsAndReadingBoundaries() {
  #expect(RankingPolicy.dice(shared: 3, query: 4, name: 6) == 6000)
  #expect(RankingPolicy.mixed(bigram: 6000, unigram: 8000) == 660_000)
  #expect(RankingPolicy.preferred(score: 1_000_000, preferred: false) == 499_999)
  #expect(RankingPolicy.preferred(score: 1_000_000, preferred: true) == 999_999)
  #expect(!RankingPolicy.gate(ratio: 1250, kana: 501, alias: false, conservative: false))
  #expect(!RankingPolicy.gate(ratio: 1251, kana: 500, alias: false, conservative: false))
  #expect(RankingPolicy.gate(ratio: 1251, kana: 501, alias: false, conservative: false))
  #expect(!RankingPolicy.conservative(han: true, lexical: 600_000, reading: 900_000))
  #expect(RankingPolicy.conservative(han: false, lexical: 600_000, reading: 900_000))
}

@Test func rankingUsesScalarsAndOrdinalUTF16() {
  #expect(RankingText.grams("a\u{1F600}b", width: 2) == ["a\u{1F600}", "\u{1F600}b"])
  #expect(RankingText.precedes("\u{10000}", "\u{E000}"))
  #expect(RankingText.compact("Ａ カ\u{FE0F}タ カナ") == "aかたかな")
  #expect(RankingText.name("フ゜", variants: [:]).unicodeScalars.map(\.value) == [0x3077])
}
