import Compression
import Foundation
import PhonebookCore

public enum SearchArtifactError: Error {
  case header
  case name(Int)
  case phones(Int)
  case parts
  case normalization(Int)
  case order(Int)
  case repeated(Int)
}

private struct ArtifactPair<First: Decodable, Second: Decodable>: Decodable {
  let first: First
  let second: Second

  init(from decoder: any Decoder) throws {
    var values = try decoder.unkeyedContainer()
    first = try values.decode(First.self)
    second = try values.decode(Second.self)
    guard values.isAtEnd else { throw RankingError.invalidArtifact }
  }
}

private struct ArtifactTriple<First: Decodable, Second: Decodable, Third: Decodable>: Decodable {
  let first: First
  let second: Second
  let third: Third

  init(from decoder: any Decoder) throws {
    var values = try decoder.unkeyedContainer()
    first = try values.decode(First.self)
    second = try values.decode(Second.self)
    third = try values.decode(Third.self)
    guard values.isAtEnd else { throw RankingError.invalidArtifact }
  }
}

public struct SearchArtifactIndex: Sendable {
  public struct Row: Sendable {
    public let name: String
    public let category: String
    public let region: String
    public let phones: [String]
  }

  public let snapshot: String
  public let rows: [Row]
  public let places: [RankingPlace]

  public func scorer(_ artifact: RankingArtifact) throws -> RankedSearch {
    try RankedSearch(
      snapshot: snapshot, rows: rows.map { RankingRow(name: $0.name, region: $0.region) },
      places: places, artifact: artifact)
  }
}

public enum SearchArtifacts {
  public static let maximumCompressedBytes = 64 * 1_048_576
  public static let maximumDecodedBytes = 256 * 1_048_576

  private struct Metadata: Decodable {
    struct Analyzer: Decodable {
      let engine: String
      let dictionary: String
    }
    let snapshot: String
    let contacts: Int
    let analyzer: Analyzer
    let readings: [String]
    let lexicon: [ArtifactTriple<String, String, Int64>]
    let aliases: [ArtifactPair<Int, String>]
    let variants: [ArtifactPair<String, String>]
    let unknownWeight: Int64
    let lexical: [ArtifactTriple<String, Int64, Int>]
    let phonetic: [ArtifactTriple<String, Int64, Int>]
  }

  public static func ranking(_ data: Data, snapshot: String, contacts: Int) throws
    -> RankingArtifact
  {
    var offset = 0
    guard data.count <= maximumDecodedBytes,
      try line(data, offset: &offset) == "public-phonebook-search-ranking\t1"
    else { throw RankingError.invalidArtifact }
    let text = try line(data, offset: &offset)
    let metadata = try JSONDecoder().decode(Metadata.self, from: Data(text.utf8))
    guard metadata.snapshot == snapshot, metadata.contacts == contacts,
      (0...2_000_000).contains(contacts), metadata.readings.count == contacts,
      !metadata.analyzer.engine.isEmpty, (try? SnapshotID(metadata.analyzer.dictionary)) != nil,
      (try? SnapshotID(snapshot)) != nil,
      Set(metadata.variants.map(\.first)).count == metadata.variants.count
    else { throw RankingError.identityMismatch }
    func postings(_ entries: [ArtifactTriple<String, Int64, Int>]) throws -> [RankingPosting] {
      try entries.map { entry in
        guard (1...max(1, contacts)).contains(entry.third), entry.third <= contacts else {
          throw RankingError.invalidArtifact
        }
        var rows: [UInt32] = []
        rows.reserveCapacity(entry.third)
        var previous = -1
        for _ in 0..<entry.third {
          var delta = 0
          var multiplier = 1
          while true {
            guard offset < data.count, multiplier <= 128 * 128 * 128 else {
              throw RankingError.invalidArtifact
            }
            let byte = Int(data[data.startIndex + offset])
            offset += 1
            delta += byte % 128 * multiplier
            if byte < 128 {
              guard multiplier == 1 || byte != 0 else { throw RankingError.invalidArtifact }
              break
            }
            multiplier *= 128
          }
          let row = previous + delta
          guard delta > 0, row < contacts else { throw RankingError.invalidArtifact }
          rows.append(UInt32(row))
          previous = row
        }
        return RankingPosting(gram: entry.first, weight: entry.second, rows: rows)
      }
    }
    let lexical = try postings(metadata.lexical)
    let phonetic = try postings(metadata.phonetic)
    guard offset == data.count else { throw RankingError.invalidArtifact }
    return try RankingArtifact(
      snapshot: snapshot, readings: metadata.readings,
      lexicon: metadata.lexicon.map { ($0.first, $0.second, $0.third) },
      aliases: metadata.aliases.map { ($0.first, $0.second) },
      variants: Dictionary(uniqueKeysWithValues: metadata.variants.map { ($0.first, $0.second) }),
      unknownWeight: metadata.unknownWeight, lexical: lexical, phonetic: phonetic)
  }

  private struct IndexHeader: Decodable {
    struct Category: Decodable {
      let id: String
      let label: String
    }
    struct Place: Decodable {
      let code: String
      let name: String
    }
    struct Parts: Decodable {
      let names: Int
      let categories: Int
      let regions: Int
      let phones: Int
    }
    let snapshot: String
    let contacts: Int
    let categories: [Category]
    let prefectures: [Place]
    let municipalities: [Place]
    let regions: [String]
    let parts: Parts
  }

  public static func index(_ data: Data) throws -> SearchArtifactIndex {
    var offset = 0
    guard data.count <= maximumDecodedBytes,
      try line(data, offset: &offset) == "public-phonebook-search-index\t1"
    else { throw SearchArtifactError.header }
    let header = try JSONDecoder().decode(
      IndexHeader.self, from: Data(line(data, offset: &offset).utf8))
    let parts = header.parts
    guard (try? SnapshotID(header.snapshot)) != nil, (0...2_000_000).contains(header.contacts),
      parts.categories == header.contacts, parts.regions == header.contacts * 2,
      parts.names >= 0, parts.phones >= 0,
      [parts.names, parts.categories, parts.regions, parts.phones].allSatisfy({ $0 <= data.count }),
      parts.names + parts.categories + parts.regions + parts.phones == data.count - offset,
      header.categories.count <= 256, header.prefectures.count == 47,
      header.municipalities.count <= 8192, header.regions.count <= 65_536
    else { throw SearchArtifactError.header }
    let namesEnd = offset + parts.names
    let categoryStart = namesEnd
    let regionStart = categoryStart + parts.categories
    var phoneOffset = regionStart + parts.regions
    var rows: [SearchArtifactIndex.Row] = []
    rows.reserveCapacity(header.contacts)
    var previous: String?
    for row in 0..<header.contacts {
      let fields = try line(data, offset: &offset).split(
        separator: "\t", omittingEmptySubsequences: false)
      guard (1...2).contains(fields.count), offset <= namesEnd else {
        throw SearchArtifactError.name(row)
      }
      let normalized = String(fields[0])
      let name = String(fields.last ?? "")
      guard !normalized.isEmpty, !name.contains("\r") else { throw SearchArtifactError.name(row) }
      guard
        SearchInput.normalizedName(name).precomposedStringWithCanonicalMapping.utf8.elementsEqual(
          normalized.utf8)
      else {
        throw SearchArtifactError.normalization(row)
      }
      guard
        previous.map({ !$0.utf8.lexicographicallyPrecedes(normalized.utf8) && $0 != normalized })
          != true
      else {
        throw SearchArtifactError.order(row)
      }
      guard fields.count != 2 || !fields[0].utf8.elementsEqual(fields[1].utf8) else {
        throw SearchArtifactError.repeated(row)
      }
      previous = normalized
      let category = Int(data[data.startIndex + categoryStart + row])
      let position = data.startIndex + regionStart + row * 2
      let region = Int(data[position]) | Int(data[position + 1]) << 8
      guard header.categories.indices.contains(category), header.regions.indices.contains(region)
      else {
        throw SearchArtifactError.name(row)
      }
      let phones = try line(data, offset: &phoneOffset).split(
        separator: " ", omittingEmptySubsequences: false
      ).map(String.init)
      guard !phones.isEmpty, Set(phones).count == phones.count,
        phones.allSatisfy({ SearchInput.normalizedPhone($0) != nil })
      else { throw SearchArtifactError.phones(row) }
      rows.append(
        SearchArtifactIndex.Row(
          name: name, category: header.categories[category].id, region: header.regions[region],
          phones: phones))
    }
    guard offset == namesEnd, phoneOffset == data.count else { throw SearchArtifactError.parts }
    return SearchArtifactIndex(
      snapshot: header.snapshot, rows: rows,
      places: header.prefectures.map {
        RankingPlace(code: $0.code, name: $0.name, prefecture: true)
      }
        + header.municipalities.map {
          RankingPlace(code: $0.code, name: $0.name, prefecture: false)
        })
  }

  private static func line(_ data: Data, offset: inout Int) throws -> String {
    guard offset < data.count, let end = data[(data.startIndex + offset)...].firstIndex(of: 10),
      let text = String(data: data[(data.startIndex + offset)..<end], encoding: .utf8)
    else { throw RankingError.invalidArtifact }
    offset = end - data.startIndex + 1
    return text
  }

  public static func decompress(_ compressed: Data) throws -> Data {
    guard compressed.count <= maximumCompressedBytes else { throw RankingError.invalidArtifact }
    let stream = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
    defer { stream.deallocate() }
    guard
      compression_stream_init(stream, COMPRESSION_STREAM_DECODE, COMPRESSION_BROTLI)
        == COMPRESSION_STATUS_OK
    else {
      throw RankingError.invalidArtifact
    }
    defer { compression_stream_destroy(stream) }
    let chunk = 262_144
    let output = UnsafeMutablePointer<UInt8>.allocate(capacity: chunk)
    defer { output.deallocate() }
    return try compressed.withUnsafeBytes { raw in
      guard let base = raw.bindMemory(to: UInt8.self).baseAddress else {
        throw RankingError.invalidArtifact
      }
      stream.pointee.src_ptr = base
      stream.pointee.src_size = raw.count
      var result = Data()
      while true {
        stream.pointee.dst_ptr = output
        stream.pointee.dst_size = chunk
        let status = compression_stream_process(stream, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))
        let produced = chunk - stream.pointee.dst_size
        guard status != COMPRESSION_STATUS_ERROR, produced <= maximumDecodedBytes - result.count
        else {
          throw RankingError.invalidArtifact
        }
        result.append(output, count: produced)
        if status == COMPRESSION_STATUS_END {
          guard stream.pointee.src_size == 0 else { throw RankingError.invalidArtifact }
          return result
        }
        guard produced > 0 else { throw RankingError.invalidArtifact }
      }
    }
  }
}
