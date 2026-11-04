import CryptoKit
import Foundation
import PhonebookCore

/// The length and SHA-256 of a decoded base archive, which a delta header names.
struct DecodedIdentity: Sendable, Equatable {
  let bytes: Int
  let sha256: SnapshotID
}

/// The saved generation or decoded archive that a delta copies rows from, in archive order.
struct DeltaBase: Sendable {
  let snapshot: SnapshotID
  let contacts: Int
  let categories: Int
  let provenances: Int
  let links: Int
  /// The decoded archive's identity, which a saved generation can't give because it keeps rows instead of the file.
  var decoded: DecodedIdentity?
  let rows: @Sendable (_ start: Int, _ count: Int) async throws -> [Data]
}

extension DeltaBase {
  init(store: SnapshotStore, manifest: SnapshotManifest) async throws {
    let header = try await store.header(generation: manifest.generation)
    let generation = manifest.generation
    self.init(
      snapshot: manifest.snapshot, contacts: manifest.records,
      categories: header.categories.count, provenances: header.provenances.count,
      links: header.links.count,
      rows: { start, count in
        try await store.archiveRows(generation: generation, from: start, count: count)
      })
  }
}

/// A Brotli archive decoded into a plain file, with the offset of every row, which a delta copies rows from.
struct DecodedArchive: Sendable {
  private static let lineFeed = UInt8(ascii: "\n")
  private static let flushBytes = 1_048_576

  let url: URL
  let header: ArchiveHeader
  let identity: DecodedIdentity
  /// The start of each row and then the end of the last one.
  let offsets: [Int]

  /// Decodes `archive` into `url`, hashing the decoded bytes and recording where each row starts.
  /// The decoded file holds every byte of the decoded stream, because each line of a readable archive ends with a line feed.
  static func decode(_ archive: URL, into url: URL) async throws -> DecodedArchive {
    guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
      throw ImportError.unavailableStorage
    }
    let writer = try FileHandle(forWritingTo: url)
    defer { try? writer.close() }
    var hasher = SHA256()
    var buffer = Data()
    var written = 0
    var line = 0
    var header: ArchiveHeader?
    var offsets: [Int] = []
    func flush() throws {
      hasher.update(data: buffer)
      try writer.write(contentsOf: buffer)
      buffer.removeAll(keepingCapacity: true)
    }
    try await BrotliLines(url: archive).eachLine { data, _ in
      defer { line += 1 }
      switch line {
      case 0:
        guard data == DirectoryArchiveReader.signature else { throw ImportError.invalidSnapshot }
      case 1:
        header = try JSONDecoder().decode(ArchiveHeader.self, from: data).validated()
      default:
        try Task.checkCancellation()
        offsets.append(written)
      }
      buffer.append(data)
      buffer.append(lineFeed)
      written += data.count + 1
      if buffer.count >= flushBytes { try flush() }
    }
    try flush()
    guard let header, offsets.count == header.contacts else { throw ImportError.unexpectedCount }
    offsets.append(written)
    let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
    return DecodedArchive(
      url: url, header: header,
      identity: DecodedIdentity(bytes: written, sha256: try SnapshotID(digest)), offsets: offsets)
  }

  /// A delta base that reads rows from the decoded file and names its identity.
  var base: DeltaBase {
    let url = url
    let offsets = offsets
    return DeltaBase(
      snapshot: header.snapshot, contacts: header.contacts, categories: header.categories.count,
      provenances: header.provenances.count, links: header.links.count, decoded: identity,
      rows: { start, count in
        guard start >= 0, count >= 0, start + count < offsets.count else {
          throw ImportError.invalidSnapshot
        }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(offsets[start]))
        let data = try handle.read(upToCount: offsets[start + count] - offsets[start]) ?? Data()
        var rows: [Data] = []
        rows.reserveCapacity(count)
        var lineStart = data.startIndex
        for index in 0..<count {
          let end = data.startIndex + offsets[start + index + 1] - offsets[start] - 1
          guard end < data.endIndex, data[end] == Self.lineFeed else {
            throw ImportError.invalidSnapshot
          }
          rows.append(data[lineStart..<end])
          lineStart = end + 1
        }
        return rows
      })
  }
}

/// Line 2 of a decoded delta, as the "Native directory deltas" section of `docs/api.md` specifies.
struct DirectoryDeltaHeader: Decodable {
  struct Archive: Decodable {
    let snapshot: SnapshotID
    let archiveSha256: SnapshotID
    let sha256: SnapshotID
    let bytes: Int
    let contacts: Int
  }

  // The dictionary limits of `src/core/directory-archive.ts`.
  private static let maximumCategories = 256
  private static let maximumProvenances = 65_536
  private static let maximumLinks = 65_536
  private static let maximumContacts = 5_000_000

  let base: Archive
  let target: Archive
  let kept: Int
  let added: Int
  let removed: Int
  let categories: [Int?]
  let provenances: [Int?]
  let links: [Int?]

  /// Bounds every count before adding any, so the row accounting can't overflow.
  var accountsForEveryRow: Bool {
    [base.contacts, target.contacts, kept, added, removed].allSatisfy {
      (0...Self.maximumContacts).contains($0)
    }
      && [base.bytes, target.bytes].allSatisfy {
        (0...DatasetDelta.maximumDecodedBytes).contains($0)
      }
      && categories.count <= Self.maximumCategories
      && provenances.count <= Self.maximumProvenances && links.count <= Self.maximumLinks
      && [categories, provenances, links].allSatisfy { $0.allSatisfy { ($0 ?? 0) >= 0 } }
      && base.snapshot != target.snapshot && kept + removed == base.contacts
      && kept + added == target.contacts
  }
}

/// A delta that the client didn't admit, so it downloads the complete archive instead.
struct DeltaRejection: Error, Equatable {
  let admission: DeltaAdmission
}

/// Rebuilds the current archive from a verified delta file and the saved rows of its base.
struct DirectoryDeltaApplier {
  let url: URL
  let decodedBytes: Int
  let target: SnapshotID
  let targetArchive: SnapshotID

  init(url: URL, decodedBytes: Int, target: SnapshotID, targetArchive: SnapshotID) {
    self.url = url
    self.decodedBytes = decodedBytes
    self.target = target
    self.targetArchive = targetArchive
  }

  init(url: URL, delta: DatasetDelta) {
    self.init(
      url: url, decodedBytes: delta.decodedBytes, target: delta.snapshot,
      targetArchive: delta.archiveSha256)
  }

  /// Streams the delta into `output`, hashing the rebuilt archive as it writes it, and returns the verdict.
  nonisolated(nonsending) func rebuild(
    from base: DeltaBase, into output: URL, progress: (Double) async -> Void = { _ in }
  ) async throws -> DeltaAdmission {
    guard FileManager.default.createFile(atPath: output.path, contents: nil) else {
      throw ImportError.unavailableStorage
    }
    let writer = try FileHandle(forWritingTo: output)
    defer { try? writer.close() }
    let rebuild = DeltaRebuild(applier: self, base: base, writer: writer)
    do {
      try await BrotliLines(url: url).eachLine { line, _ in
        try await rebuild.accept(line, progress: progress)
      }
      return try rebuild.finish()
    } catch let rejection as DeltaRejection {
      return rejection.admission
    }
  }
}

/// The state of one rebuild, which reads the delta once and holds at most one batch of base rows.
private final class DeltaRebuild {
  private static let signature = Data("public-phonebook-directory-delta\t1".utf8)
  private static let flushBytes = 1_048_576
  private static let lineFeed = UInt8(ascii: "\n")
  private static let tab = UInt8(ascii: "\t")
  private static let listSeparator = UInt8(0x1F)
  private static let confirmedWithoutLink = Data("*".utf8)
  private static let copyMarker = Data("=".utf8)
  private static let addPrefix = Data("+\t".utf8)
  private static let rowFields = 9
  private static let categoryField = 0
  private static let provenanceField = 6
  private static let originField = 7
  private static let confirmationField = 8
  private static let copyFields = 3
  private static let markerField = 0
  private static let startField = 1
  private static let countField = 2
  private static let leadingLines = 3
  private static let maximumDigits = 9
  private static let decimalRadix = 10
  private static let digits = UInt8(ascii: "0")...UInt8(ascii: "9")
  private static let bitsPerWord = 64

  private let applier: DirectoryDeltaApplier
  private let base: DeltaBase
  private let writer: FileHandle
  private var header: DirectoryDeltaHeader?
  private var sizes = (categories: 0, provenances: 0, links: 0)
  private var copied: [UInt64] = []
  private var hasher = SHA256()
  private var buffer = Data()
  private var line = 0
  private var decoded = 0
  private var bytes = 0
  private var rows = 0
  private var kept = 0
  private var added = 0

  init(applier: DirectoryDeltaApplier, base: DeltaBase, writer: FileHandle) {
    self.applier = applier
    self.base = base
    self.writer = writer
  }

  nonisolated(nonsending) func accept(_ data: Data, progress: (Double) async -> Void)
    async throws
  {
    defer { line += 1 }
    decoded += data.count + 1
    guard decoded <= applier.decodedBytes else { throw DeltaRejection(admission: .malformed) }
    switch line {
    case 0:
      guard data == Self.signature else { throw DeltaRejection(admission: .malformed) }
    case 1: header = try admitHeader(data)
    case 2: try admitTargetHeader(data)
    default: try await instruction(data, progress: progress)
    }
  }

  func finish() throws -> DeltaAdmission {
    guard let header, line >= Self.leadingLines else { return .malformed }
    try flush()
    let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
    return DeltaAdmission.decide(
      baseMatches: true,
      wellFormed: kept == header.kept && added == header.added && decoded == applier.decodedBytes,
      rows: rows, expectedRows: header.target.contacts, bytes: bytes,
      expectedBytes: header.target.bytes, digestMatches: digest == header.target.sha256.rawValue)
  }

  private func admitHeader(_ data: Data) throws -> DirectoryDeltaHeader {
    let header: DirectoryDeltaHeader
    do { header = try JSONDecoder().decode(DirectoryDeltaHeader.self, from: data) } catch {
      throw DeltaRejection(admission: .malformed)
    }
    guard header.accountsForEveryRow else { throw DeltaRejection(admission: .malformed) }
    guard header.base.snapshot == base.snapshot, header.base.contacts == base.contacts,
      header.categories.count == base.categories, header.provenances.count == base.provenances,
      header.links.count == base.links,
      base.decoded.map({
        $0 == DecodedIdentity(bytes: header.base.bytes, sha256: header.base.sha256)
      })
        ?? true
    else { throw DeltaRejection(admission: .baseMismatch) }
    copied = Array(repeating: 0, count: (base.contacts + Self.bitsPerWord - 1) / Self.bitsPerWord)
    return header
  }

  private func admitTargetHeader(_ data: Data) throws {
    guard let header else { throw DeltaRejection(admission: .malformed) }
    let archive: ArchiveHeader
    do { archive = try JSONDecoder().decode(ArchiveHeader.self, from: data).validated() } catch {
      throw DeltaRejection(admission: .malformed)
    }
    sizes = (archive.categories.count, archive.provenances.count, archive.links.count)
    func fits(_ map: [Int?], _ size: Int) -> Bool {
      map.allSatisfy { $0.map { $0 < size } ?? true }
    }
    guard archive.snapshot == header.target.snapshot, archive.contacts == header.target.contacts,
      header.target.snapshot == applier.target,
      header.target.archiveSha256 == applier.targetArchive,
      fits(header.categories, sizes.categories), fits(header.provenances, sizes.provenances),
      fits(header.links, sizes.links)
    else { throw DeltaRejection(admission: .malformed) }
    try write(DirectoryArchiveReader.signature)
    try write(data)
  }

  private nonisolated(nonsending) func instruction(
    _ data: Data, progress: (Double) async -> Void
  ) async throws {
    guard let header else { throw DeltaRejection(admission: .malformed) }
    if data.starts(with: Self.addPrefix) {
      let row = data.dropFirst(Self.addPrefix.count)
      guard row.split(separator: Self.tab, omittingEmptySubsequences: false).count == Self.rowFields
      else { throw DeltaRejection(admission: .malformed) }
      try writeRow(row, header)
      added += 1
      return
    }
    let fields = data.split(separator: Self.tab, omittingEmptySubsequences: false)
    guard fields.count == Self.copyFields, fields[Self.markerField] == Self.copyMarker,
      let start = Self.decimal(fields[Self.startField], positive: false),
      let count = Self.decimal(fields[Self.countField], positive: true),
      DeltaAdmission.admitsCopy(start: start, count: count, baseRows: base.contacts)
    else { throw DeltaRejection(admission: .malformed) }
    for position in start..<(start + count) {
      let (word, bit) = position.quotientAndRemainder(dividingBy: Self.bitsPerWord)
      let mask = UInt64(1) << UInt64(bit)
      guard copied[word] & mask == 0 else { throw DeltaRejection(admission: .malformed) }
      copied[word] |= mask
    }
    var offset = 0
    while offset < count {
      try Task.checkCancellation()
      let size = min(SnapshotStore.archiveRowBatch, count - offset)
      let batch = try await base.rows(start + offset, size)
      guard batch.count == size else { throw ImportError.invalidSnapshot }
      for row in batch {
        guard let mapped = remap(row) else { throw DeltaRejection(admission: .malformed) }
        try writeRow(mapped, header)
      }
      offset += size
      await progress(Double(rows) / Double(max(header.target.contacts, 1)))
    }
    kept += count
  }

  /// Rewrites the dictionary indices of a saved row through the header maps, as `remapRow` in `src/core/directory-delta.ts` does.
  private func remap(_ row: Data) -> Data? {
    guard let header else { return nil }
    var fields = row.split(separator: Self.tab, omittingEmptySubsequences: false).map { Data($0) }
    guard fields.count == Self.rowFields,
      let category = Self.map(fields[Self.categoryField], header.categories, sizes.categories),
      let provenance = Self.map(fields[Self.provenanceField], header.provenances, sizes.provenances)
    else { return nil }
    var origin: [Data] = []
    for item in fields[Self.originField].split(
      separator: Self.listSeparator, omittingEmptySubsequences: false)
    {
      guard let link = Self.map(item, header.links, sizes.links) else { return nil }
      origin.append(link)
    }
    let confirmation = fields[Self.confirmationField]
    if !confirmation.isEmpty, confirmation != Self.confirmedWithoutLink {
      guard let link = Self.map(confirmation, header.links, sizes.links) else { return nil }
      fields[Self.confirmationField] = link
    }
    fields[Self.categoryField] = category
    fields[Self.provenanceField] = provenance
    fields[Self.originField] = Data(origin.joined(separator: [Self.listSeparator]))
    return Data(fields.joined(separator: [Self.tab]))
  }

  private static func map(_ text: some Collection<UInt8>, _ map: [Int?], _ size: Int) -> Data? {
    guard let index = decimal(text, positive: false), index < map.count, let mapped = map[index],
      mapped < size
    else { return nil }
    return Data(String(mapped).utf8)
  }

  /// Parses a decimal without a sign or leading zeros, as `decimalIndex` and `decimalCount` admit.
  private static func decimal(_ text: some Collection<UInt8>, positive: Bool) -> Int? {
    guard (1...maximumDigits).contains(text.count), text.allSatisfy({ digits.contains($0) }),
      text.count == 1 || text.first != digits.lowerBound
    else { return nil }
    let value = text.reduce(0) { $0 * decimalRadix + Int($1 - digits.lowerBound) }
    return positive && value == 0 ? nil : value
  }

  private func writeRow(_ row: some Collection<UInt8>, _ header: DirectoryDeltaHeader) throws {
    rows += 1
    guard rows <= header.target.contacts else { throw DeltaRejection(admission: .malformed) }
    try write(row)
  }

  private func write(_ line: some Collection<UInt8>) throws {
    buffer.append(contentsOf: line)
    buffer.append(Self.lineFeed)
    bytes += line.count + 1
    if buffer.count >= Self.flushBytes { try flush() }
  }

  private func flush() throws {
    hasher.update(data: buffer)
    try writer.write(contentsOf: buffer)
    buffer.removeAll(keepingCapacity: true)
  }
}
