import Foundation

private struct PackedPair<A: Decodable, B: Decodable>: Decodable {
  let first: A
  let second: B

  init(from decoder: any Decoder) throws {
    var values = try decoder.unkeyedContainer()
    first = try values.decode(A.self)
    second = try values.decode(B.self)
    guard values.isAtEnd else { throw RankingError.invalidArtifact }
  }
}

private struct PackedMetadata: Decodable {
  struct Analyzer: Decodable {
    let engine: String
    let dictionary: String
  }
  let snapshot: String
  let contacts: Int
  let sourceSha256: String
  let analyzer: Analyzer
  let variants: [PackedPair<String, String>]
  let aliases: [PackedPair<Int, String>]
  let unknownWeight: Int64
  let literalUsesFolded: Bool
  let sections: [PackedPair<String, Int>]
}

struct PackedBytes: Sendable {
  let data: Data
  let range: Range<Int>

  var count: Int { range.count }

  func word(_ index: Int) -> Int {
    data.withUnsafeBytes {
      Int(
        UInt32(
          littleEndian: $0.loadUnaligned(
            fromByteOffset: range.lowerBound + index * 4, as: UInt32.self)))
    }
  }

  func text(_ start: Int, _ end: Int) -> String {
    String(decoding: data[(range.lowerBound + start)..<(range.lowerBound + end)], as: UTF8.self)
  }
}

public struct PackedDictionary: Sendable {
  let table: PackedBytes
  let values: PackedBytes
  let strings: PackedBytes
  let offsets: PackedBytes
  let weights: PackedBytes?
  let fixed: Bool

  var count: Int { table.count / 12 }

  private func text(_ id: Int) -> String {
    strings.text(offsets.word(id), offsets.word(id + 1))
  }

  private func key(_ at: Int) -> String { text(table.word(at * 3)) }

  func lowerBound(_ key: String) -> Int {
    var low = 0
    var high = count
    while low < high {
      let middle = PackedRankingPolicy.midpoint(low: low, high: high)
      if RankingText.precedes(self.key(middle), key) { low = middle + 1 } else { high = middle }
    }
    return low
  }

  func find(_ key: String) -> Int? {
    let at = lowerBound(key)
    return at < count && self.key(at).utf16.elementsEqual(key.utf16) ? at : nil
  }

  public func count(_ key: String) -> Int {
    guard let at = find(key) else { return 0 }
    return table.word(at * 3 + 2)
  }

  private func visitAt(_ at: Int, _ visit: (Int) -> Void) {
    let start = table.word(at * 3 + 1)
    let end = at + 1 == count ? values.count : table.word((at + 1) * 3 + 1)
    if fixed {
      for position in stride(from: start / 4, to: end / 4, by: 1) { visit(values.word(position)) }
      return
    }
    values.data.withUnsafeBytes { raw in
      let bytes = raw.bindMemory(to: UInt8.self)
      var previous = -1
      var delta = 0
      var multiplier = 1
      for position in start..<end {
        let byte = Int(bytes[values.range.lowerBound + position])
        delta += byte % 128 * multiplier
        if byte < 128 {
          previous += delta
          visit(previous)
          delta = 0
          multiplier = 1
        } else {
          multiplier *= 128
        }
      }
    }
  }

  @discardableResult
  public func visit(_ key: String, _ visit: (Int, Int64) -> Void) -> Int64? {
    guard let at = find(key) else { return nil }
    let weight = Int64(weights?.word(at) ?? 0)
    visitAt(at) { visit($0, weight) }
    return weight
  }

  public func rows(_ key: String) -> [Int] {
    var rows: [Int] = []
    visit(key) { row, _ in rows.append(row) }
    return rows
  }

  func choices(_ surface: String) -> [String]? {
    let at = lowerBound(surface)
    guard at < count, key(at).hasPrefix(surface) else { return nil }
    guard key(at).utf16.elementsEqual(surface.utf16) else { return [] }
    var result: [String] = []
    visitAt(at) { result.append(text($0)) }
    return result
  }

  func validate(stringCount: Int, maximum: Int) throws {
    guard table.count.isMultiple(of: 12), weights == nil || weights?.count == count * 4 else {
      throw RankingError.invalidArtifact
    }
    for at in 0..<count {
      let start = table.word(at * 3 + 1)
      let end = at + 1 == count ? values.count : table.word((at + 1) * 3 + 1)
      let expected = table.word(at * 3 + 2)
      guard table.word(at * 3) < stringCount, start <= end, end <= values.count,
        at != 0 || start == 0, expected > 0, expected <= maximum,
        !fixed || (start.isMultiple(of: 4) && end - start == expected * 4),
        weights.map({ (1...100_000).contains($0.word(at)) }) ?? true
      else { throw RankingError.invalidArtifact }
      if fixed {
        for position in (start / 4)..<(end / 4) {
          guard values.word(position) < maximum else { throw RankingError.invalidArtifact }
        }
      } else {
        try values.data.withUnsafeBytes { raw in
          let bytes = raw.bindMemory(to: UInt8.self)
          var previous = -1
          var delta = 0
          var multiplier = 1
          var seen = 0
          for position in start..<end {
            let byte = Int(bytes[values.range.lowerBound + position])
            delta += byte % 128 * multiplier
            if byte < 128 {
              previous += delta
              guard delta > 0, multiplier == 1 || byte != 0, previous < maximum else {
                throw RankingError.invalidArtifact
              }
              seen += 1
              delta = 0
              multiplier = 1
            } else {
              multiplier *= 128
              guard multiplier <= 128 * 128 * 128 else { throw RankingError.invalidArtifact }
            }
          }
          guard multiplier == 1, seen == expected else { throw RankingError.invalidArtifact }
        }
      }
    }
  }
}

public final class PackedRanking: Sendable {
  public let snapshot: String
  public let contacts: Int
  public let sourceSha256: String
  public let variants: [String: String]
  public let aliases: [(row: Int, kana: String)]
  public let unknownWeight: Int64
  public let lexical: PackedDictionary
  public let phonetic: PackedDictionary
  public let short: PackedDictionary
  private let lexicon: PackedDictionary
  private let rows: PackedBytes
  private let norms: PackedBytes
  private let trigrams: PackedBytes
  private let strings: PackedBytes
  private let offsets: PackedBytes
  private let exactOrders: [String: PackedBytes]
  private let literalUsesFolded: Bool

  public init(data: Data, snapshot: String, contacts: Int, completeValidation: Bool = true) throws {
    guard data.count <= PackedRankingPolicy.maximumBytes,
      let first = data.firstIndex(of: 10),
      String(decoding: data[..<first], as: UTF8.self) == "public-phonebook-search-ranking\t2",
      let second = data[(first + 1)...].firstIndex(of: 10), second < 65_536
    else { throw RankingError.invalidArtifact }
    let metadata = try JSONDecoder().decode(PackedMetadata.self, from: data[(first + 1)..<second])
    guard metadata.snapshot == snapshot, metadata.contacts == contacts,
      (0...2_000_000).contains(contacts), (try? SnapshotID(snapshot)) != nil,
      (try? SnapshotID(metadata.sourceSha256)) != nil,
      (try? SnapshotID(metadata.analyzer.dictionary)) != nil, !metadata.analyzer.engine.isEmpty,
      (1...100_000).contains(metadata.unknownWeight),
      Set(metadata.variants.map(\.first)).count == metadata.variants.count,
      metadata.aliases.allSatisfy({ (0..<contacts).contains($0.first) && !$0.second.isEmpty })
    else { throw RankingError.identityMismatch }
    let variants = Dictionary(uniqueKeysWithValues: metadata.variants.map { ($0.first, $0.second) })
    guard
      variants.allSatisfy({
        $0.key.unicodeScalars.count == 1 && $0.value.unicodeScalars.count == 1
          && variants[$0.value] == nil
      })
    else { throw RankingError.invalidArtifact }
    var sections: [String: PackedBytes] = [:]
    var offset = (second + 4) / 4 * 4
    for section in metadata.sections {
      guard sections[section.first] == nil,
        PackedRankingPolicy.fits(offset: offset, length: section.second, size: data.count)
      else { throw RankingError.invalidArtifact }
      sections[section.first] = PackedBytes(data: data, range: offset..<(offset + section.second))
      offset = (offset + section.second + 3) / 4 * 4
    }
    guard offset == data.count else { throw RankingError.invalidArtifact }
    func section(_ name: String, width: Int = 4) throws -> PackedBytes {
      guard let bytes = sections[name], bytes.count.isMultiple(of: width) else {
        throw RankingError.invalidArtifact
      }
      return bytes
    }
    let strings = try section("strings", width: 1)
    let offsets = try section("offsets")
    let rows = try section("rows", width: 12)
    let norms = try section("norms")
    let trigrams = try section("trigrams")
    guard offsets.count >= 4, rows.count == contacts * 12, norms.count == contacts * 4,
      trigrams.count == contacts * 4
    else { throw RankingError.invalidArtifact }
    let stringCount = offsets.count / 4 - 1
    func dictionary(_ name: String) throws -> PackedDictionary {
      let value = try PackedDictionary(
        table: section(name, width: 12), values: section(name + ":values", width: 1),
        strings: strings, offsets: offsets,
        weights: name == "lexical" ? section("weights") : nil,
        fixed: name == "short" || name == "lexicon")
      if completeValidation {
        try value.validate(
          stringCount: stringCount, maximum: name == "lexicon" ? stringCount : contacts)
      }
      return value
    }
    let exactOrders = try Dictionary(
      uniqueKeysWithValues: ["original", "written", "folded", "literal", "reading"].map { name in
        let shared = name == "literal" && metadata.literalUsesFolded ? "folded" : name
        let bytes = try section(shared + ":order")
        guard bytes.count == contacts * 4 else { throw RankingError.invalidArtifact }
        if completeValidation {
          var seen = [UInt8](repeating: 0, count: contacts)
          for position in 0..<contacts {
            let row = bytes.word(position)
            guard row < contacts, seen[row] == 0 else { throw RankingError.invalidArtifact }
            seen[row] = 1
          }
        }
        return (name, bytes)
      })
    if completeValidation {
      var previous = 0
      for id in 0...stringCount {
        let end = offsets.word(id)
        guard end >= previous, end <= strings.count, id != 0 || end == 0,
          end == strings.count || data[strings.range.lowerBound + end] & 0xc0 != 0x80
        else { throw RankingError.invalidArtifact }
        previous = end
      }
      guard previous == strings.count,
        String(data: data[strings.range], encoding: .utf8) != nil
      else { throw RankingError.invalidArtifact }
      for row in 0..<contacts {
        guard rows.word(row * 3) < stringCount, rows.word(row * 3 + 1) < stringCount else {
          throw RankingError.invalidArtifact
        }
      }
    }
    self.snapshot = snapshot
    self.contacts = contacts
    sourceSha256 = metadata.sourceSha256
    self.variants = variants
    aliases = metadata.aliases.map { ($0.first, $0.second) }
    unknownWeight = metadata.unknownWeight
    literalUsesFolded = metadata.literalUsesFolded
    self.strings = strings
    self.offsets = offsets
    self.rows = rows
    self.norms = norms
    self.trigrams = trigrams
    self.exactOrders = exactOrders
    lexical = try dictionary("lexical")
    phonetic = try dictionary("phonetic")
    short = try dictionary("short")
    lexicon = try dictionary("lexicon")
  }

  private func text(_ id: Int) -> String {
    strings.text(offsets.word(id), offsets.word(id + 1))
  }

  public func name(_ row: Int) -> String { text(rows.word(row * 3)) }
  public func reading(_ row: Int) -> String { text(rows.word(row * 3 + 1)) }
  public func literal(_ row: Int) -> String {
    literalUsesFolded ? name(row) : RankingText.compact(name(row))
  }
  public func length(_ row: Int) -> Int { rows.word(row * 3 + 2) >> 16 }
  public func characters(_ row: Int) -> Int64 { Int64(rows.word(row * 3 + 2) & 0xffff) }
  public func norm(_ row: Int) -> Int64 { Int64(norms.word(row)) }
  public func trigramCount(_ row: Int, reading: Bool) -> Int {
    reading ? trigrams.word(row) >> 16 : trigrams.word(row) & 0xffff
  }
  func choices(_ surface: String) -> [String]? { lexicon.choices(surface) }

  func exact(_ kind: String, key: String, keyOf: (Int) -> String) -> [Int]? {
    guard let order = exactOrders[kind] else { return nil }
    var low = 0
    var high = contacts
    while low < high {
      let middle = PackedRankingPolicy.midpoint(low: low, high: high)
      if RankingText.precedes(keyOf(order.word(middle)), key) {
        low = middle + 1
      } else {
        high = middle
      }
    }
    var result: [Int] = []
    while low < contacts {
      let row = order.word(low)
      guard keyOf(row).utf16.elementsEqual(key.utf16) else { break }
      result.append(row)
      low += 1
    }
    return result.isEmpty ? nil : result
  }
}
