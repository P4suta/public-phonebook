public enum RankingError: Error {
  case invalidArtifact, identityMismatch, invalidCorpus
}

public struct RankingRow: Sendable {
  public let name: String
  public let region: String

  public init(name: String, region: String) {
    self.name = name
    self.region = region
  }
}

public struct RankingPlace: Sendable {
  public let code: String
  public let name: String
  public let prefecture: Bool

  public init(code: String, name: String, prefecture: Bool) {
    self.code = code
    self.name = name
    self.prefecture = prefecture
  }
}

public struct RankingPosting: Sendable {
  public let gram: String
  public let weight: Int64
  public let rows: [UInt32]

  public init(gram: String, weight: Int64, rows: [UInt32]) {
    self.gram = gram
    self.weight = weight
    self.rows = rows
  }
}

public struct RankingArtifact: Sendable {
  public let packed: PackedRanking?
  public let snapshot: String
  public let readings: RankingValues<String>
  public let lexicon: [(surface: String, reading: String, count: Int64)]
  public let aliases: [(row: Int, kana: String)]
  public let variants: [String: String]
  public let unknownWeight: Int64
  public let lexical: [RankingPosting]
  public let phonetic: [RankingPosting]

  public init(
    snapshot: String, readings: [String],
    lexicon: [(surface: String, reading: String, count: Int64)],
    aliases: [(row: Int, kana: String)], variants: [String: String], unknownWeight: Int64,
    lexical: [RankingPosting], phonetic: [RankingPosting]
  ) throws {
    guard readings.count <= 2_000_000, (1...100_000).contains(unknownWeight),
      aliases.allSatisfy({ readings.indices.contains($0.row) && !$0.kana.isEmpty }),
      lexicon.allSatisfy({
        !$0.surface.isEmpty && !$0.reading.isEmpty && (1...9_007_199_254_740_991).contains($0.count)
          && $0.reading.unicodeScalars.count <= 8192
      }),
      variants.allSatisfy({
        $0.key.unicodeScalars.count == 1 && $0.value.unicodeScalars.count == 1
          && variants[$0.value] == nil
      })
    else { throw RankingError.invalidArtifact }
    for postings in [lexical, phonetic] {
      guard Set(postings.map(\.gram)).count == postings.count else {
        throw RankingError.invalidArtifact
      }
      for posting in postings {
        guard !posting.gram.isEmpty, !posting.rows.isEmpty,
          (0...100_000).contains(posting.weight),
          posting.rows.count <= readings.count
        else { throw RankingError.invalidArtifact }
        var previous: Int64 = -1
        for row in posting.rows {
          guard Int64(row) > previous, Int(row) < readings.count else {
            throw RankingError.invalidArtifact
          }
          previous = Int64(row)
        }
      }
    }
    guard lexical.allSatisfy({ $0.weight > 0 }) else { throw RankingError.invalidArtifact }
    self.packed = nil
    self.snapshot = snapshot
    self.readings = RankingValues(readings)
    self.lexicon = lexicon
    self.aliases = aliases
    self.variants = variants
    self.unknownWeight = unknownWeight
    self.lexical = lexical
    self.phonetic = phonetic
  }

  public init(packed: PackedRanking) {
    self.packed = packed
    snapshot = packed.snapshot
    readings = RankingValues(count: packed.contacts) { packed.reading($0) }
    lexicon = []
    aliases = packed.aliases
    variants = packed.variants
    unknownWeight = packed.unknownWeight
    lexical = []
    phonetic = []
  }
}

public struct RankedHit: Sendable, Equatable {
  public let row: Int
  public let score: Int64

  public init(row: Int, score: Int64) {
    self.row = row
    self.score = score
  }
}
