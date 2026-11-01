import Foundation
import PhonebookCore

/// Searches the normalized names of one generation in memory, with the website's name ranking.
public final class LocalSearch: Sendable {
  public struct Match: Sendable, Equatable {
    public let row: Int
    public let rank: NameRank
    public var id: Int64 { Int64(row + 1) }
  }

  private let names: Data
  private let kinds: Data
  private let offsets: [UInt32]

  init(names: URL, kinds: URL) throws {
    let text = try Data(contentsOf: names, options: .alwaysMapped)
    let categories = try Data(contentsOf: kinds, options: .alwaysMapped)
    guard text.count < Int(UInt32.max) else { throw ImportError.invalidSnapshot }
    var offsets: [UInt32] = [0]
    offsets.reserveCapacity(categories.count + 1)
    text.withUnsafeBytes { raw in
      guard let base = raw.baseAddress else { return }
      var position = 0
      while position < raw.count,
        let found = memchr(base + position, 0x0A, raw.count - position)
      {
        position = base.distance(to: UnsafeRawPointer(found)) + 1
        offsets.append(UInt32(position))
      }
    }
    guard offsets.last.map(Int.init) == text.count, offsets.count == categories.count + 1 else {
      throw ImportError.invalidSnapshot
    }
    self.names = text
    self.kinds = categories
    self.offsets = offsets
  }

  public var count: Int { kinds.count }

  public func category(row: Int) -> Int { Int(kinds[kinds.startIndex + row]) }

  /// Returns the matches of a normalized query grouped by category, each group ordered by rank,
  /// name, and record, and the groups ordered by their first match.
  public func search(_ query: String) throws -> [[Match]] {
    let needle = Array(query.utf8)
    guard !needle.isEmpty, needle.count <= SearchInput.maximumQueryBytes, !needle.contains(0x0A)
    else { return [] }
    var matches: [Match] = []
    try names.withUnsafeBytes { raw in
      guard let base = raw.baseAddress else { return }
      try needle.withUnsafeBytes { pattern in
        var position = 0
        while position < raw.count,
          let hit = memmem(
            base + position, raw.count - position, pattern.baseAddress, pattern.count)
        {
          let offset = base.distance(to: UnsafeRawPointer(hit))
          let row = self.row(containing: offset)
          let start = Int(offsets[row])
          let end = Int(offsets[row + 1]) - 1
          let rank: NameRank =
            offset == start ? (end - start == needle.count ? .exact : .prefix) : .substring
          matches.append(Match(row: row, rank: rank))
          position = end + 1
          if matches.count.isMultiple(of: 4096) { try Task.checkCancellation() }
        }
      }
    }
    return try grouped(matches)
  }

  /// Groups records that matched exactly, such as every record listing one telephone number.
  public func exact(_ ids: [Int64]) throws -> [[Match]] {
    try grouped(
      ids.compactMap { id in
        let row = Int(id) - 1
        return (0..<count).contains(row) ? Match(row: row, rank: .exact) : nil
      })
  }

  private func grouped(_ matches: [Match]) throws -> [[Match]] {
    var groups: [Int: [Match]] = [:]
    for match in matches { groups[category(row: match.row), default: []].append(match) }
    return try names.withUnsafeBytes { raw -> [[Match]] in
      func precedes(_ lhs: Match, _ rhs: Match) -> Bool {
        if lhs.rank != rhs.rank { return lhs.rank < rhs.rank }
        let left = Int(offsets[lhs.row])
        let right = Int(offsets[rhs.row])
        let leftLength = Int(offsets[lhs.row + 1]) - 1 - left
        let rightLength = Int(offsets[rhs.row + 1]) - 1 - right
        let common = min(leftLength, rightLength)
        if common > 0, let base = raw.baseAddress {
          let order = memcmp(base + left, base + right, common)
          if order != 0 { return order < 0 }
        }
        if leftLength != rightLength { return leftLength < rightLength }
        return lhs.row < rhs.row
      }
      var result: [[Match]] = []
      for group in groups.values {
        try Task.checkCancellation()
        result.append(group.sorted(by: precedes))
      }
      return result.sorted { precedes($0[0], $1[0]) }
    }
  }

  private func row(containing offset: Int) -> Int {
    var low = 0
    var high = offsets.count - 1
    while low + 1 < high {
      let middle = (low + high) / 2
      if Int(offsets[middle]) <= offset { low = middle } else { high = middle }
    }
    return low
  }
}
