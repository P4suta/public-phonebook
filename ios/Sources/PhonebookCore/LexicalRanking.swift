struct LexicalRanking: Sendable {
  private struct Candidate {
    let row: Int
    let bigram: Int64
  }

  private let names: RankingValues<String>
  private let packed: PackedRanking?
  private let postings: [String: RankingPosting]
  private let norms: [Int64]
  private let characters: [Int64]
  private let unknownWeight: Int64

  init(names: RankingValues<String>, artifact: RankingArtifact) throws {
    self.names = names
    packed = artifact.packed
    postings = Dictionary(uniqueKeysWithValues: artifact.lexical.map { ($0.gram, $0) })
    var norms = [Int64](repeating: 0, count: artifact.packed == nil ? names.count : 0)
    for posting in artifact.lexical {
      for row in posting.rows {
        norms[Int(row)] += posting.weight
        guard norms[Int(row)] <= 100_000_000_000_000 else {
          throw RankingError.invalidArtifact
        }
      }
    }
    self.norms = norms
    characters =
      artifact.packed == nil ? names.map { Int64(RankingText.grams($0, width: 1).count) } : []
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

  private func packedCandidates(_ grams: [String], packed: PackedRanking) -> [Candidate] {
    var sums = [UInt32](repeating: 0, count: names.count)
    var touched = [UInt32](repeating: 0, count: names.count)
    var count = 0
    var queryWeight: Int64 = 0
    var heap: [Candidate] = []
    sums.withUnsafeMutableBufferPointer { sums in
      touched.withUnsafeMutableBufferPointer { touched in
        for gram in grams {
          let weight = packed.lexical.visit(gram) { row, weight in
            if sums[row] == 0 {
              touched[count] = UInt32(row)
              count += 1
            }
            sums[row] = PackedRankingPolicy.scratchSum(total: sums[row], increment: UInt32(weight))
          }
          queryWeight += weight ?? unknownWeight
        }
        for at in 0..<count {
          let row = Int(touched[at])
          Self.retain(
            Candidate(
              row: row,
              bigram: RankingPolicy.dice(
                shared: Int64(sums[row]), query: queryWeight, name: packed.norm(row))), in: &heap)
        }
      }
    }
    return heap
  }

  private func legacyCandidates(_ grams: [String]) -> [Candidate] {
    var shared: [Int: Int64] = [:]
    var queryWeight: Int64 = 0
    for gram in grams {
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
          row: row,
          bigram: RankingPolicy.dice(
            shared: weight, query: queryWeight, name: norms[row])
        ),
        in: &heap)
    }
    return heap
  }

  func search(_ query: String) throws -> [RankedHit] {
    let text = RankingText.compact(query)
    let grams = RankingText.grams(text, width: 2)
    let heap = packed.map { packedCandidates(grams, packed: $0) } ?? legacyCandidates(grams)
    let points = RankingText.grams(text, width: 1)
    return heap.map { candidate in
      let name = names[candidate.row]
      let overlap = points.filter { name.contains($0) }.count
      return RankedHit(
        row: candidate.row,
        score: RankingPolicy.mixed(
          bigram: candidate.bigram,
          unigram: RankingPolicy.dice(
            shared: Int64(overlap), query: Int64(points.count),
            name: packed?.characters(candidate.row) ?? characters[candidate.row])))
    }.sorted { $0.score != $1.score ? $0.score > $1.score : $0.row < $1.row }
      .prefix(RankingPolicy.results).map { $0 }
  }
}
