import Foundation
import PhonebookCore

/// Searches the comparison names of one generation in memory, with the website's words, tiers, and order.
public final class LocalSearch: Sendable {
  public struct Match: Sendable, Equatable {
    public let row: Int
    public let rank: NameRank
    public var id: Int64 { Int64(row + 1) }
  }

  /// The comparison forms of the region names and category labels that a word may match instead of a name.
  /// A region index counts the 47 prefectures first and then the header's municipalities.
  public struct Places: Sendable {
    public let regions: [(prefecture: String, municipality: String)]
    public let categories: [String]
  }

  private let names: Data
  private let folded: Data
  private let kinds: Data
  private let regions: Data
  private let offsets: [UInt32]
  private let foldedOffsets: [UInt32]
  private let places: Places

  init(names: URL, folded: URL, kinds: URL, regions: URL, places: Places) throws {
    let text = try Data(contentsOf: names, options: .alwaysMapped)
    let comparison = try Data(contentsOf: folded, options: .alwaysMapped)
    let categories = try Data(contentsOf: kinds, options: .alwaysMapped)
    let rowRegions = try Data(contentsOf: regions, options: .alwaysMapped)
    let offsets = try Self.lineOffsets(text, rows: categories.count)
    let foldedOffsets = try Self.lineOffsets(comparison, rows: categories.count)
    guard rowRegions.count == categories.count * 2 else { throw ImportError.invalidSnapshot }
    self.names = text
    self.folded = comparison
    self.kinds = categories
    self.regions = rowRegions
    self.offsets = offsets
    self.foldedOffsets = foldedOffsets
    self.places = places
    for row in 0..<categories.count {
      guard places.regions.indices.contains(region(row: row)),
        places.categories.indices.contains(category(row: row))
      else { throw ImportError.invalidSnapshot }
    }
  }

  private static func lineOffsets(_ text: Data, rows: Int) throws -> [UInt32] {
    guard text.count < Int(UInt32.max) else { throw ImportError.invalidSnapshot }
    var offsets: [UInt32] = [0]
    offsets.reserveCapacity(rows + 1)
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
    guard offsets.last.map(Int.init) == text.count, offsets.count == rows + 1 else {
      throw ImportError.invalidSnapshot
    }
    return offsets
  }

  public var count: Int { kinds.count }

  public func category(row: Int) -> Int { Int(kinds[kinds.startIndex + row]) }

  private func region(row: Int) -> Int {
    let start = regions.startIndex + row * 2
    return Int(regions[start]) | Int(regions[start + 1]) << 8
  }

  /// Returns the rows that hold every folded word in their name, region, or category, grouped by category.
  /// Each group is ordered by rank, name, and record, and the groups by their first match.
  public func search(_ words: [String]) throws -> [[Match]] {
    let needles = words.map { Array($0.utf8) }
    guard !needles.isEmpty, needles.count <= SearchInput.maximumQueryWords,
      words.joined(separator: " ").utf8.count <= SearchInput.maximumQueryBytes,
      needles.allSatisfy({ !$0.isEmpty && !$0.contains(0x0A) })
    else { return [] }
    var masks = [UInt8](repeating: 0, count: count)
    var hits: [[Int]] = []
    var nameRanks: [Int: NameRank] = [:]
    for (bit, needle) in needles.enumerated() {
      var rows: [Int] = []
      try scan(needle) { row, rank in
        masks[row] |= 1 << bit
        rows.append(row)
        if needles.count == 1 { nameRanks[row] = rank }
      }
      hits.append(rows)
    }
    let held = words.map(holding)
    let candidates =
      held.firstIndex(where: { !$0.any }).map { hits[$0] } ?? Array(0..<count)
    var matches: [Match] = []
    for (step, row) in candidates.enumerated() {
      if step.isMultiple(of: 65_536) { try Task.checkCancellation() }
      let mask = masks[row]
      let named = mask.nonzeroBitCount
      var placed = 0
      if named < needles.count {
        let region = region(row: row)
        let kind = category(row: row)
        for bit in 0..<needles.count where mask & (1 << bit) == 0 {
          if held[bit].regions[region] || held[bit].categories[kind] { placed += 1 }
        }
      }
      if let rank = SearchInput.wordRank(
        words: needles.count, named: named, placed: placed,
        nameRank: nameRanks[row] ?? .substring)
      {
        matches.append(Match(row: row, rank: rank))
      }
    }
    return try grouped(matches)
  }

  /// The regions and categories whose comparison form holds a word.
  private func holding(_ word: String) -> (regions: [Bool], categories: [Bool], any: Bool) {
    let needle = word.utf8
    let regions = places.regions.map {
      $0.prefecture.utf8.firstRange(of: needle) != nil
        || $0.municipality.utf8.firstRange(of: needle) != nil
    }
    let categories = places.categories.map { $0.utf8.firstRange(of: needle) != nil }
    return (regions, categories, regions.contains(true) || categories.contains(true))
  }

  /// Reports each row whose comparison name holds the needle once, with the rank of its first occurrence.
  private func scan(_ needle: [UInt8], _ visit: (Int, NameRank) -> Void) throws {
    try folded.withUnsafeBytes { raw in
      guard let base = raw.baseAddress else { return }
      try needle.withUnsafeBytes { pattern in
        var position = 0
        var found = 0
        while position < raw.count,
          let hit = memmem(
            base + position, raw.count - position, pattern.baseAddress, pattern.count)
        {
          let offset = base.distance(to: UnsafeRawPointer(hit))
          let row = Self.row(containing: offset, in: foldedOffsets)
          let start = Int(foldedOffsets[row])
          let end = Int(foldedOffsets[row + 1]) - 1
          visit(
            row,
            offset == start ? (end - start == needle.count ? .exact : .prefix) : .substring)
          position = end + 1
          found += 1
          if found.isMultiple(of: 4096) { try Task.checkCancellation() }
        }
      }
    }
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

  private static func row(containing offset: Int, in offsets: [UInt32]) -> Int {
    var low = 0
    var high = offsets.count - 1
    while low + 1 < high {
      let middle = (low + high) / 2
      if Int(offsets[middle]) <= offset { low = middle } else { high = middle }
    }
    return low
  }
}

extension ArchiveHeader {
  /// The region index of each code that a record may carry: a prefecture's position, or 47 plus a listed municipality's position.
  /// A municipality code missing from the header indexes its prefecture, because only the prefecture's name is known for it.
  var searchRegionIndexes: [String: UInt16] {
    var indexes: [String: UInt16] = [:]
    for (position, prefecture) in prefectures.enumerated() {
      indexes[prefecture.code.rawValue] = UInt16(position)
    }
    for (position, municipality) in municipalities.enumerated() {
      indexes[municipality.code] = UInt16(prefectures.count + position)
    }
    return indexes
  }

  var searchPlaces: LocalSearch.Places {
    LocalSearch.Places(
      regions: prefectures.map { (SearchInput.searchForm($0.name), "") }
        + municipalities.map { municipality in
          (
            SearchInput.searchForm(
              prefectures.first { $0.code == municipality.prefectureCode }?.name ?? ""),
            SearchInput.searchForm(municipality.name)
          )
        },
      categories: categories.map { SearchInput.searchForm($0.label) })
  }
}
