public enum RankingPolicy {
  public static let results = 100
  public static let queryPoints = 256

  public static func dice(shared: Int64, query: Int64, name: Int64) -> Int64 {
    let total = query + name
    return total == 0 ? 0 : 20_000 * shared / total
  }

  public static func mixed(bigram: Int64, unigram: Int64) -> Int64 {
    (bigram * 7 + unigram * 3) / 10 * 100
  }

  public static func reading(literal: Bool, exactKana: Bool, lexical: Int64, kana: Int64)
    -> Int64
  {
    if literal { return 1_000_000 }
    if exactKana { return 900_000 + lexical * 9 }
    return lexical * 20 + kana * 60
  }

  public static func signal(_ score: Int64) -> Int64 {
    score == 1_000_000 ? 999_999 : score
  }

  public static func preferred(score: Int64, preferred: Bool) -> Int64 {
    score * 499_999 / 1_000_000 + (preferred ? 500_000 : 0)
  }

  public static func conservative(han: Bool, lexical: Int64, reading: Int64) -> Bool {
    reading >= 900_000 && lexical <= 600_000 && (!han || reading > 900_000)
  }

  public static func gate(ratio: Int64, kana: Int64, alias: Bool, conservative: Bool) -> Bool {
    alias || conservative || (ratio > 1250 && kana > 500)
  }
}
