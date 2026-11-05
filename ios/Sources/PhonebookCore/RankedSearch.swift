public final class RankedSearch: Sendable {
  private struct Signals {
    let hits: [RankedHit]
    let lexical: [RankedHit]
    let reading: [RankedHit]
    let locked: Bool
  }

  private let rows: [RankingRow]
  private let names: [String]
  private let lengths: [Int]
  private let variants: [String: String]
  private let originalExact: [String: [Int]]
  private let writtenExact: [String: [Int]]
  private let foldedExact: [String: [Int]]
  private let shortPostings: [String: [Int]]
  private let aliases: [String: [Int]]
  private let lexical: LexicalRanking
  private let reading: ReadingRanking
  private let places: PlaceRanking

  public init(
    snapshot: String, rows: [RankingRow], places: [RankingPlace], artifact: RankingArtifact
  )
    throws
  {
    guard snapshot == artifact.snapshot, rows.count == artifact.readings.count else {
      throw RankingError.identityMismatch
    }
    guard rows.allSatisfy({ !$0.name.isEmpty && $0.name.utf8.count <= 4096 }) else {
      throw RankingError.invalidCorpus
    }
    self.rows = rows
    variants = artifact.variants
    let names = rows.map { RankingText.name($0.name, variants: artifact.variants) }
    self.names = names
    let lengths = names.map { $0.unicodeScalars.count }
    self.lengths = lengths
    var originalExact: [String: [Int]] = [:]
    var writtenExact: [String: [Int]] = [:]
    var foldedExact: [String: [Int]] = [:]
    var shortPostings: [String: [Int]] = [:]
    for (row, entry) in rows.enumerated() {
      originalExact[RankingText.original(entry.name), default: []].append(row)
      writtenExact[
        RankingText.compact(entry.name).precomposedStringWithCanonicalMapping, default: []
      ].append(row)
      foldedExact[names[row], default: []].append(row)
      for key in Set(
        RankingText.grams(names[row], width: 1) + RankingText.grams(names[row], width: 2))
      {
        shortPostings[key, default: []].append(row)
      }
    }
    for key in shortPostings.keys {
      shortPostings[key]?.sort { lengths[$0] != lengths[$1] ? lengths[$0] < lengths[$1] : $0 < $1 }
    }
    self.originalExact = originalExact
    self.writtenExact = writtenExact
    self.foldedExact = foldedExact
    self.shortPostings = shortPostings
    var aliases: [String: [Int]] = [:]
    for alias in artifact.aliases {
      aliases[RankingText.compact(alias.kana), default: []].append(alias.row)
    }
    self.aliases = aliases
    lexical = try LexicalRanking(names: names, artifact: artifact)
    reading = try ReadingRanking(names: names, artifact: artifact)
    self.places = PlaceRanking(places)
  }

  private static func union(_ left: [RankedHit], _ right: [RankedHit]) -> [RankedHit] {
    var positions: [Int: Int] = [:]
    var hits: [RankedHit] = []
    for hit in left + right {
      if let at = positions[hit.row] {
        if hits[at].score < hit.score { hits[at] = hit }
      } else {
        positions[hit.row] = hits.count
        hits.append(hit)
      }
    }
    return hits
  }

  private func base(_ query: String) throws -> Signals {
    let folded = RankingText.name(query, variants: variants)
    let length = folded.unicodeScalars.count
    let empty = Signals(hits: [], lexical: [], reading: [], locked: true)
    guard length > 0, length <= RankingPolicy.queryPoints else { return empty }
    if let exact = originalExact[RankingText.original(query)]
      ?? writtenExact[RankingText.compact(query).precomposedStringWithCanonicalMapping]
      ?? foldedExact[folded]
    {
      return Signals(
        hits: exact.prefix(RankingPolicy.results).map { RankedHit(row: $0, score: 1_000_000) },
        lexical: [], reading: [], locked: true)
    }
    if length <= 2 {
      return Signals(
        hits: (shortPostings[folded] ?? []).prefix(RankingPolicy.results).map {
          RankedHit(row: $0, score: 1_000_000 / Int64(1 + lengths[$0]))
        }, lexical: [], reading: [], locked: true)
    }
    let lexical = try lexical.search(folded)
    let reading = try reading.search(folded)
    let primary = Set(lexical.map(\.row))
    let merged =
      lexical.map { RankedHit(row: $0.row, score: RankingPolicy.signal($0.score)) }
      + reading.filter { !primary.contains($0.row) }.map { RankedHit(row: $0.row, score: 0) }
    return Signals(
      hits: Array(merged.prefix(RankingPolicy.results)), lexical: lexical, reading: reading,
      locked: false)
  }

  public func search(_ query: String) throws -> [RankedHit] {
    let original = try base(query)
    if original.locked { return original.hits }
    let parsed = places.parse(query)
    let local = parsed.conditions.isEmpty ? original : try base(parsed.stripped)
    let folded = RankingText.name(parsed.stripped, variants: variants)
    let tied = parsed.conditions.isEmpty ? places.tied(query) : parsed.conditions
    var preferred = Set<Int>()
    var tiedRegion = Set<Int>()
    func order(_ hits: [RankedHit]) -> [RankedHit] {
      for hit in hits {
        if PlaceRanking.matches(rows[hit.row], conditions: parsed.conditions) {
          preferred.insert(hit.row)
        }
        if PlaceRanking.matches(rows[hit.row], conditions: tied) { tiedRegion.insert(hit.row) }
      }
      return hits.sorted {
        if preferred.contains($0.row) != preferred.contains($1.row) {
          return preferred.contains($0.row)
        }
        if $0.score != $1.score { return $0.score > $1.score }
        if tiedRegion.contains($0.row) != tiedRegion.contains($1.row) {
          return tiedRegion.contains($0.row)
        }
        return $0.row < $1.row
      }
    }
    let lexicalHits = order(
      Self.union(local.lexical.isEmpty ? local.hits : local.lexical, original.lexical))
    var readingHits = order(
      Self.union(local.reading.isEmpty ? local.hits : local.reading, original.reading))
    let alias = RankingText.hasHan(folded) ? [] : aliases[folded] ?? []
    if !alias.isEmpty {
      readingHits = order(Self.union(alias.map { RankedHit(row: $0, score: 990_000) }, readingHits))
    }
    let lexicalScore = lexicalHits.first?.score ?? 0
    let readingScore = readingHits.first?.score ?? 0
    let ratio = lexicalScore == 0 ? 4000 : min(4000, readingScore * 1000 / lexicalScore)
    let points = folded.unicodeScalars.count
    let kana = points == 0 ? 0 : Int64(RankingText.kanaCount(folded) * 1000 / points)
    let conservative =
      parsed.conditions.isEmpty
      && RankingPolicy.conservative(
        han: RankingText.hasHan(RankingText.name(query, variants: variants)),
        lexical: original.lexical.first?.score ?? 0, reading: original.reading.first?.score ?? 0)
    let takeReading =
      !readingHits.isEmpty
      && RankingPolicy.gate(
        ratio: ratio, kana: kana, alias: !alias.isEmpty, conservative: conservative)
    let primary = takeReading ? readingHits : lexicalHits
    let secondary = takeReading ? lexicalHits : readingHits
    let raw = Dictionary(uniqueKeysWithValues: primary.map { ($0.row, $0.score) })
    return Self.union(primary, secondary).map {
      RankedHit(
        row: $0.row,
        score: RankingPolicy.preferred(
          score: raw[$0.row] ?? 0, preferred: preferred.contains($0.row)))
    }.sorted {
      if $0.score != $1.score { return $0.score > $1.score }
      let left = raw[$0.row] ?? 0
      let right = raw[$1.row] ?? 0
      if left != right { return left > right }
      if tiedRegion.contains($0.row) != tiedRegion.contains($1.row) {
        return tiedRegion.contains($0.row)
      }
      return $0.row < $1.row
    }.prefix(RankingPolicy.results).map { $0 }
  }
}
