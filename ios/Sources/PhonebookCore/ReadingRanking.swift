private struct ReadingPath {
  let reading: String
  let cost: Int
}

struct ReadingTrie: Sendable {
  private struct Choice: Sendable {
    let reading: String
    var count: Int64
  }
  private struct Node: Sendable {
    var children: [Unicode.Scalar: Int] = [:]
    var choices: [Choice] = []
  }
  private let nodes: [Node]
  private let packed: PackedRanking?

  init(_ lexicon: [(surface: String, reading: String, count: Int64)], packed: PackedRanking? = nil)
    throws
  {
    self.packed = packed
    var nodes = [Node()]
    for entry in lexicon {
      let key = RankingText.compact(entry.surface)
      let reading = RankingText.compact(entry.reading)
      if key.isEmpty || reading.isEmpty { continue }
      var at = 0
      for point in key.unicodeScalars {
        if let child = nodes[at].children[point] {
          at = child
        } else {
          let child = nodes.count
          nodes[at].children[point] = child
          nodes.append(Node())
          at = child
        }
      }
      if let choice = nodes[at].choices.firstIndex(where: { $0.reading == reading }) {
        guard nodes[at].choices[choice].count <= 9_007_199_254_740_991 - entry.count else {
          throw RankingError.invalidArtifact
        }
        nodes[at].choices[choice].count += entry.count
      } else {
        nodes[at].choices.append(Choice(reading: reading, count: entry.count))
      }
    }
    for index in nodes.indices {
      nodes[index].choices.sort {
        $0.count != $1.count ? $0.count > $1.count : RankingText.precedes($0.reading, $1.reading)
      }
      nodes[index].choices = Array(nodes[index].choices.prefix(8))
    }
    self.nodes = nodes
  }

  private static func retain(_ candidate: ReadingPath, in paths: inout [ReadingPath]) {
    if let duplicate = paths.firstIndex(where: { $0.reading == candidate.reading }) {
      if paths[duplicate].cost <= candidate.cost { return }
      paths.remove(at: duplicate)
    }
    paths.append(candidate)
    paths.sort {
      $0.cost != $1.cost ? $0.cost < $1.cost : RankingText.precedes($0.reading, $1.reading)
    }
    if paths.count > 8 { paths.removeLast() }
  }

  func readings(_ query: String) -> [String] {
    let points = Array(RankingText.compact(query).unicodeScalars)
    var paths = [[ReadingPath]](repeating: [], count: points.count + 1)
    paths[0] = [ReadingPath(reading: "", cost: 0)]
    for at in points.indices {
      let point = String(points[at])
      let fallbackCost = RankingText.hasHan(point) ? 1000 : 0
      var tokens: [(end: Int, choices: [String])] = []
      if let packed {
        var surface = ""
        for end in at..<points.count {
          surface += String(points[end])
          guard let choices = packed.choices(surface) else { break }
          if !choices.isEmpty { tokens.append((end, choices)) }
        }
      }
      for path in paths[at] {
        Self.retain(
          ReadingPath(
            reading: path.reading + point, cost: path.cost + fallbackCost),
          in: &paths[at + 1])
        if packed != nil {
          for token in tokens {
            for (rank, choice) in token.choices.enumerated() {
              Self.retain(
                ReadingPath(reading: path.reading + choice, cost: path.cost + 1 + rank),
                in: &paths[token.end + 1])
            }
          }
          continue
        }
        var node = 0
        for end in at..<points.count {
          guard let child = nodes[node].children[points[end]] else { break }
          node = child
          for (rank, choice) in nodes[node].choices.enumerated() {
            Self.retain(
              ReadingPath(reading: path.reading + choice.reading, cost: path.cost + 1 + rank),
              in: &paths[end + 1])
          }
        }
      }
    }
    return paths[points.count].map(\.reading)
  }
}

struct ReadingRanking: Sendable {
  private struct Candidate {
    let hit: RankedHit
    let literal: String
  }
  private let names: RankingValues<String>
  private let readings: RankingValues<String>
  private let packed: PackedRanking?
  private let trie: ReadingTrie
  private let literalExact: [String: [Int]]
  private let readingExact: [String: [Int]]
  private let postings: [String: [UInt32]]

  init(names: RankingValues<String>, artifact: RankingArtifact) throws {
    packed = artifact.packed
    if let packed = artifact.packed {
      self.names = RankingValues(count: names.count) { packed.literal($0) }
      readings = artifact.readings
    } else {
      self.names = RankingValues(names.map(RankingText.compact))
      readings = RankingValues(artifact.readings.map(RankingText.compact))
    }
    trie = try ReadingTrie(artifact.lexicon, packed: artifact.packed)
    var literalExact: [String: [Int]] = [:]
    var readingExact: [String: [Int]] = [:]
    for row in artifact.packed == nil ? names.indices : 0..<0 {
      literalExact[self.names[row], default: []].append(row)
      readingExact[readings[row], default: []].append(row)
    }
    self.literalExact = literalExact
    self.readingExact = readingExact
    postings = Dictionary(uniqueKeysWithValues: artifact.phonetic.map { ($0.gram, $0.rows) })
  }

  private static func dice(_ query: [String], _ name: [String]) -> Int64 {
    let own = Set(name)
    return RankingPolicy.dice(
      shared: Int64(query.filter(own.contains).count), query: Int64(query.count),
      name: Int64(name.count))
  }

  private func packedCandidates(_ keys: ArraySlice<String>, packed: PackedRanking) -> [Int] {
    var frequencies = [UInt32](repeating: 0, count: names.count)
    var touched = [UInt32](repeating: 0, count: names.count)
    var count = 0
    return frequencies.withUnsafeMutableBufferPointer { frequencies in
      touched.withUnsafeMutableBufferPointer { touched in
        for key in keys {
          packed.phonetic.visit(key) { row, _ in
            if frequencies[row] == 0 {
              touched[count] = UInt32(row)
              count += 1
            }
            frequencies[row] = PackedRankingPolicy.scratchSum(total: frequencies[row], increment: 1)
          }
        }
        for at in 0..<count {
          let row = Int(touched[at])
          touched[at] = PackedRankingPolicy.readingKey(
            row: row, contacts: names.count, frequency: frequencies[row])
        }
        let ordered = touched.prefix(count).sorted()
        return ordered.prefix(512).map { Int($0) % names.count }
      }
    }
  }

  func search(_ query: String) throws -> [RankedHit] {
    let literal = RankingText.compact(query)
    guard !literal.isEmpty, literal.unicodeScalars.count <= RankingPolicy.queryPoints else {
      return []
    }
    let paths = trie.readings(query)
    var exact = Set(
      packed?.exact("literal", key: literal) { names[$0] } ?? literalExact[literal] ?? [])
    for reading in paths {
      exact.formUnion(
        packed?.exact("reading", key: reading) { readings[$0] } ?? readingExact[reading] ?? [])
    }
    let lexical = RankingText.grams(literal, width: 3)
    let phonetic = paths.map { RankingText.grams($0, width: 3) }
    var candidates = Array(exact)
    if candidates.isEmpty {
      let keys = Set(lexical + phonetic.flatMap { $0 }).filter {
        packed?.phonetic.count($0) ?? postings[$0]?.count ?? 0 > 0
      }.sorted {
        let left = packed?.phonetic.count($0) ?? postings[$0]?.count ?? 0
        let right = packed?.phonetic.count($1) ?? postings[$1]?.count ?? 0
        return left != right ? left < right : RankingText.precedes($0, $1)
      }.prefix(6)
      var counts: [Int: Int] = [:]
      if let packed {
        candidates = packedCandidates(keys, packed: packed)
      } else {
        for key in keys {
          for row in postings[key] ?? [] { counts[Int(row), default: 0] += 1 }
        }
        candidates = counts.keys.sorted {
          let left = counts[$0] ?? 0
          let right = counts[$1] ?? 0
          return left != right ? left > right : $0 < $1
        }.prefix(512).map { $0 }
      }
    }
    return candidates.map { row in
      let reading = readings[row]
      let name = names[row]
      let readingGrams = packed == nil ? RankingText.grams(reading, width: 3) : []
      let kana =
        phonetic.map { grams in
          packed.map { Self.packedDice(grams, reading, count: $0.trigramCount(row, reading: true)) }
            ?? Self.dice(grams, readingGrams)
        }.max() ?? 0
      return Candidate(
        hit: RankedHit(
          row: row,
          score: RankingPolicy.reading(
            literal: name == literal, exactKana: paths.contains(reading),
            lexical: packed.map {
              Self.packedDice(lexical, name, count: $0.trigramCount(row, reading: false))
            } ?? Self.dice(lexical, RankingText.grams(name, width: 3)), kana: kana)), literal: name)
    }.filter { $0.hit.score > 0 }.sorted {
      if $0.hit.score != $1.hit.score { return $0.hit.score > $1.hit.score }
      if $0.literal != $1.literal {
        return RankingText.precedes($0.literal, $1.literal)
      }
      return $0.hit.row < $1.hit.row
    }.prefix(RankingPolicy.results).map(\.hit)
  }

  static func packedDice(_ query: [String], _ name: String, count: Int) -> Int64 {
    if name.count != name.unicodeScalars.count {
      return dice(query, RankingText.grams(name, width: 3))
    }
    let shared = query.filter { $0.unicodeScalars.count < 3 ? name == $0 : name.contains($0) }.count
    return RankingPolicy.dice(shared: Int64(shared), query: Int64(query.count), name: Int64(count))
  }
}
