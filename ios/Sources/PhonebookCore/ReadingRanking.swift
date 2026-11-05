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

  init(_ lexicon: [(surface: String, reading: String, count: Int64)]) throws {
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
      for path in paths[at] {
        let point = String(points[at])
        Self.retain(
          ReadingPath(
            reading: path.reading + point, cost: path.cost + (RankingText.hasHan(point) ? 1000 : 0)),
          in: &paths[at + 1])
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
  private let names: [String]
  private let readings: [String]
  private let trie: ReadingTrie
  private let literalExact: [String: [Int]]
  private let readingExact: [String: [Int]]
  private let postings: [String: [UInt32]]

  init(names: [String], artifact: RankingArtifact) throws {
    self.names = names.map(RankingText.compact)
    readings = artifact.readings.map(RankingText.compact)
    trie = try ReadingTrie(artifact.lexicon)
    var literalExact: [String: [Int]] = [:]
    var readingExact: [String: [Int]] = [:]
    for row in names.indices {
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

  func search(_ query: String) throws -> [RankedHit] {
    let literal = RankingText.compact(query)
    guard !literal.isEmpty, literal.unicodeScalars.count <= RankingPolicy.queryPoints else {
      return []
    }
    let paths = trie.readings(query)
    var exact = Set(literalExact[literal] ?? [])
    for reading in paths { exact.formUnion(readingExact[reading] ?? []) }
    let lexical = RankingText.grams(literal, width: 3)
    let phonetic = paths.map { RankingText.grams($0, width: 3) }
    var candidates = Array(exact)
    if candidates.isEmpty {
      let keys = Set(lexical + phonetic.flatMap { $0 }).filter { postings[$0] != nil }.sorted {
        let left = postings[$0]?.count ?? 0
        let right = postings[$1]?.count ?? 0
        return left != right ? left < right : RankingText.precedes($0, $1)
      }.prefix(6)
      var counts: [Int: Int] = [:]
      for key in keys {
        for row in postings[key] ?? [] { counts[Int(row), default: 0] += 1 }
      }
      candidates = counts.keys.sorted {
        let left = counts[$0] ?? 0
        let right = counts[$1] ?? 0
        return left != right ? left > right : $0 < $1
      }.prefix(512).map { $0 }
    }
    return candidates.map { row in
      let readingGrams = RankingText.grams(readings[row], width: 3)
      let kana = phonetic.map { Self.dice($0, readingGrams) }.max() ?? 0
      return RankedHit(
        row: row,
        score: RankingPolicy.reading(
          literal: names[row] == literal, exactKana: paths.contains(readings[row]),
          lexical: Self.dice(lexical, RankingText.grams(names[row], width: 3)), kana: kana))
    }.filter { $0.score > 0 }.sorted {
      if $0.score != $1.score { return $0.score > $1.score }
      if names[$0.row] != names[$1.row] {
        return RankingText.precedes(names[$0.row], names[$1.row])
      }
      return $0.row < $1.row
    }.prefix(RankingPolicy.results).map { $0 }
  }
}
