struct LexicalRanking: Sendable {
  private struct Candidate {
    let row: Int
    let bigram: Int64
  }

  private let names: [String]
  private let postings: [String: RankingPosting]
  private let norms: [Int64]
  private let characters: [Int64]
  private let unknownWeight: Int64

  init(names: [String], artifact: RankingArtifact) throws {
    self.names = names
    postings = Dictionary(uniqueKeysWithValues: artifact.lexical.map { ($0.gram, $0) })
    var norms = [Int64](repeating: 0, count: names.count)
    for posting in artifact.lexical {
      for row in posting.rows {
        norms[Int(row)] += posting.weight
        guard norms[Int(row)] <= 100_000_000_000_000 else {
          throw RankingError.invalidArtifact
        }
      }
    }
    self.norms = norms
    characters = names.map { Int64(RankingText.grams($0, width: 1).count) }
    unknownWeight = artifact.unknownWeight
  }

  private static func worse(_ left: Candidate, _ right: Candidate) -> Bool {
    left.bigram < right.bigram || (left.bigram == right.bigram && left.row > right.row)
  }

  private static func retain(_ item: Candidate, in heap: inout [Candidate]) {
    if heap.count < 200 {
      heap.append(item)
      var position = heap.count - 1
      while position > 0 {
        let parent = (position - 1) / 2
        if !worse(heap[position], heap[parent]) { break }
        heap.swapAt(position, parent)
        position = parent
      }
      return
    }
    guard worse(heap[0], item) else { return }
    heap[0] = item
    var position = 0
    while true {
      let left = position * 2 + 1
      let right = left + 1
      var chosen = position
      if left < heap.count, worse(heap[left], heap[chosen]) { chosen = left }
      if right < heap.count, worse(heap[right], heap[chosen]) { chosen = right }
      if chosen == position { break }
      heap.swapAt(chosen, position)
      position = chosen
    }
  }

  func search(_ query: String) throws -> [RankedHit] {
    let text = RankingText.compact(query)
    var shared: [Int: Int64] = [:]
    var queryWeight: Int64 = 0
    for gram in RankingText.grams(text, width: 2) {
      let posting = postings[gram]
      queryWeight += posting?.weight ?? unknownWeight
      if let posting {
        for row in posting.rows { shared[Int(row), default: 0] += posting.weight }
      }
    }
    var heap: [Candidate] = []
    for (row, weight) in shared {
      Self.retain(
        Candidate(
          row: row, bigram: RankingPolicy.dice(shared: weight, query: queryWeight, name: norms[row])
        ),
        in: &heap)
    }
    let points = RankingText.grams(text, width: 1)
    return heap.map { candidate in
      let name = names[candidate.row]
      let overlap = points.filter { name.contains($0) }.count
      return RankedHit(
        row: candidate.row,
        score: RankingPolicy.mixed(
          bigram: candidate.bigram,
          unigram: RankingPolicy.dice(
            shared: Int64(overlap), query: Int64(points.count), name: characters[candidate.row])))
    }.sorted { $0.score != $1.score ? $0.score > $1.score : $0.row < $1.row }
      .prefix(RankingPolicy.results).map { $0 }
  }
}
