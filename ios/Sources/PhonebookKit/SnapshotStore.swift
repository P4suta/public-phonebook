import CryptoKit
import Foundation
import PhonebookCore

public struct SnapshotManifest: Codable, Sendable {
  public static let currentFormat = 4

  public let format: Int
  public let generation: UUID
  public let previous: UUID?
  public let snapshot: SnapshotID
  public let generatedAt: String
  public let updatedAt: Date
  public let records: Int
  public let origin: String?
  public let rankedSearch: Bool?

  init(
    format: Int, generation: UUID, previous: UUID?, snapshot: SnapshotID, generatedAt: String,
    updatedAt: Date, records: Int, origin: String?, rankedSearch: Bool? = nil
  ) {
    self.format = format
    self.generation = generation
    self.previous = previous
    self.snapshot = snapshot
    self.generatedAt = generatedAt
    self.updatedAt = updatedAt
    self.records = records
    self.origin = origin
    self.rankedSearch = rankedSearch
  }
}

public struct IdentificationEntry: Sendable, Equatable {
  public let number: Int64
  public let label: String
}

private final class SnapshotDraft {
  let generation: UUID
  let header: ArchiveHeader
  let database: SQLiteDatabase
  let lease: WriterLease
  let names: FileHandle
  let folded: FileHandle
  let origin: String?
  let regionIndexes: [String: UInt16]
  var insertContact: SQLiteStatement?
  var insertPhone: SQLiteStatement?
  var kinds = Data()
  var regions = Data()
  var records = 0
  var inserting = PhaseTimer()
  var phase: PublicationPhase = .staging
  var requiresRankedSearch = false
  var searchReady = false

  init(
    generation: UUID, header: ArchiveHeader, database: SQLiteDatabase, lease: WriterLease,
    names: FileHandle, folded: FileHandle, origin: String?
  ) throws {
    self.generation = generation
    self.header = header
    self.database = database
    self.lease = lease
    self.names = names
    self.folded = folded
    self.origin = origin
    regionIndexes = header.searchRegionIndexes
    insertContact = try database.prepare(
      "INSERT INTO contacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    insertPhone = try database.prepare("INSERT OR IGNORE INTO phones VALUES (?, ?)")
  }

  func finalizeStatements() {
    insertContact = nil
    insertPhone = nil
  }
}

/// The dictionaries of one generation, indexed for building contacts.
struct ArchiveIndex: Sendable {
  let header: ArchiveHeader
  let prefectures: [String: String]
  let municipalities: [String: String]

  init(header: ArchiveHeader) {
    self.header = header
    prefectures = Dictionary(
      uniqueKeysWithValues: header.prefectures.map { ($0.code.rawValue, $0.name) })
    municipalities = Dictionary(
      header.municipalities.map { ($0.code, $0.name) }, uniquingKeysWith: { first, _ in first })
  }
}

/// Builds the caller label of each number from the rows that list it, in number order.
private struct CallerLabels {
  private var current: Int64?
  private var names: [String] = []
  private var categories: [String] = []

  /// Adds one row and returns the finished label of the previous number when the number changes.
  mutating func add(number: Int64, name: String, category: String) throws -> IdentificationEntry? {
    let finished = number == current ? nil : try finish()
    if number != current {
      current = number
      names.removeAll(keepingCapacity: true)
      categories.removeAll(keepingCapacity: true)
    }
    guard names.count < 4096 else { throw ImportError.projectionTooLarge }
    names.append(name)
    categories.append(category)
    return finished
  }

  func finish() throws -> IdentificationEntry? {
    guard let current else { return nil }
    let category =
      categories.count == 1 ? categories[0] : Set(categories).sorted().joined(separator: "・")
    let label = CallerLabel.make(names: names, category: category)
    guard label.utf8.count <= 1024 else { throw ImportError.projectionTooLarge }
    return IdentificationEntry(number: current, label: label)
  }
}

public actor SnapshotStore {
  public let root: URL
  private var draft: SnapshotDraft?
  private var indexes: [UUID: ArchiveIndex] = [:]
  private let makeGeneration: @Sendable () -> UUID
  private let files: any SnapshotFiles
  private let trace: any TraceSink
  public private(set) var cleanupPending = false

  public init(
    root: URL, makeGeneration: @escaping @Sendable () -> UUID = UUID.init,
    files: any SnapshotFiles = LocalSnapshotFiles(), trace: any TraceSink = DiscardingTraceSink()
  ) throws {
    self.root = root
    self.makeGeneration = makeGeneration
    self.files = files
    self.trace = trace
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    var root = root
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try root.setResourceValues(values)
    #if os(iOS)
      try FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
        ofItemAtPath: root.path
      )
    #endif
  }

  /// Where downloads keep their received bytes until a generation activates, so an interrupted download resumes.
  public nonisolated var transfers: URL {
    root.appendingPathComponent("transfers", isDirectory: true)
  }

  public nonisolated var searchTransfers: URL {
    root.appendingPathComponent("search-transfers", isDirectory: true)
  }

  private static let generationExtensions = ["sqlite", "names", "folded", "kinds", "regions"]
  private static let searchExtensions = [
    "search-index.br", "search-ranking.br", "search.json", "search-rows",
  ]
  private static let mappedSearchExtensions = [
    "search-index", "search-ranking", "search-lines", "search.json", "search-rows",
  ]
  /// A generation saved before the caller file existed still opens, so the file isn't one of the required extensions.
  private static let callerExtension = "callers"
  private var manifestURL: URL { root.appendingPathComponent("active.json") }

  private func url(_ generation: UUID, _ kind: String) -> URL {
    root.appendingPathComponent(generation.uuidString + "." + kind)
  }

  public func manifest() throws -> SnapshotManifest? {
    try readManifest(requiringSearchArtifacts: true)
  }

  private func readManifest(requiringSearchArtifacts: Bool) throws -> SnapshotManifest? {
    guard FileManager.default.fileExists(atPath: manifestURL.path) else { return nil }
    struct Format: Decodable { let format: Int }
    let data = try files.readManifest(at: manifestURL)
    // An earlier storage format needs a fresh save, so it counts as no saved directory.
    guard try JSONDecoder().decode(Format.self, from: data).format == SnapshotManifest.currentFormat
    else { return nil }
    let manifest = try JSONDecoder().decode(SnapshotManifest.self, from: data)
    guard (0...5_000_000).contains(manifest.records),
      (0...253_402_300_799).contains(manifest.updatedAt.timeIntervalSince1970),
      manifest.previous != manifest.generation,
      Self.generationExtensions.allSatisfy({
        FileManager.default.fileExists(atPath: url(manifest.generation, $0).path)
      }),
      !requiringSearchArtifacts || manifest.rankedSearch != true
        || [Self.searchExtensions, Self.mappedSearchExtensions].contains(where: { extensions in
          extensions.allSatisfy {
            FileManager.default.fileExists(atPath: url(manifest.generation, $0).path)
          }
        })
    else { throw ImportError.invalidSnapshot }
    return manifest
  }

  public func removeSearchArtifacts() throws {
    guard draft == nil else { throw ImportError.alreadyUpdating }
    let lease = try WriterLease(url: root.appendingPathComponent("writer.sqlite"))
    defer { lease.release() }
    if let saved = try readManifest(requiringSearchArtifacts: false), saved.rankedSearch == true {
      let literal = SnapshotManifest(
        format: saved.format, generation: saved.generation, previous: saved.previous,
        snapshot: saved.snapshot, generatedAt: saved.generatedAt, updatedAt: saved.updatedAt,
        records: saved.records, origin: saved.origin)
      try files.activateManifest(JSONEncoder().encode(literal), at: manifestURL)
    }
    let extensions = Set(Self.searchExtensions + Self.mappedSearchExtensions)
    for item in try FileManager.default.contentsOfDirectory(
      at: root, includingPropertiesForKeys: nil)
    {
      let name = item.lastPathComponent
      if name == "search-transfers"
        || (name.count > 37 && UUID(uuidString: String(name.prefix(36))) != nil
          && name.dropFirst(36).first == "." && extensions.contains(String(name.dropFirst(37))))
      {
        try files.removeGeneration(at: item)
      }
    }
  }

  public func begin(header: ArchiveHeader, origin: URL? = nil, requiresRankedSearch: Bool = false)
    throws
  {
    guard draft == nil else { throw ImportError.alreadyUpdating }
    let lease = try WriterLease(url: root.appendingPathComponent("writer.sqlite"))
    try HeldLocks.current?.hold(lease)
    let active = try manifest()
    do {
      try cleanup(retaining: Set([active?.generation, active?.previous].compactMap { $0 }))
      cleanupPending = false
    } catch { cleanupPending = true }
    let generation = makeGeneration()
    try Data().write(to: url(generation, "sqlite"), options: .withoutOverwriting)
    try Data().write(to: url(generation, "names"), options: .withoutOverwriting)
    try Data().write(to: url(generation, "folded"), options: .withoutOverwriting)
    do {
      // Nothing else opens a staging generation, so its connection takes no file lock that iOS could find held at suspension.
      let database = try SQLiteDatabase(
        url: url(generation, "sqlite"), readOnly: false, fileLocking: false)
      try database.execute("PRAGMA journal_mode = OFF")
      try database.execute("PRAGMA synchronous = OFF")
      for statement in [
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID",
        "CREATE TABLE categories (id INTEGER PRIMARY KEY, label TEXT NOT NULL)",
        """
        CREATE TABLE contacts (
          id INTEGER PRIMARY KEY, category INTEGER NOT NULL, region TEXT NOT NULL,
          name TEXT NOT NULL, address TEXT NOT NULL, phones TEXT NOT NULL, website TEXT,
          provenance INTEGER NOT NULL, origin TEXT NOT NULL, confirmation TEXT NOT NULL)
        """,
        """
        CREATE TABLE phones (
          number INTEGER NOT NULL, contact INTEGER NOT NULL, PRIMARY KEY (number, contact)
        ) WITHOUT ROWID
        """,
      ] {
        try database.execute(statement)
      }
      try database.execute("BEGIN")
      let encoded = try JSONEncoder().encode(header)
      try database.execute(
        "INSERT INTO meta VALUES ('header', ?)", [.text(String(decoding: encoded, as: UTF8.self))])
      for (index, category) in header.categories.enumerated() {
        try database.execute(
          "INSERT INTO categories VALUES (?, ?)", [.integer(Int64(index)), .text(category.label)])
      }
      draft = try SnapshotDraft(
        generation: generation, header: header, database: database, lease: lease,
        names: try FileHandle(forWritingTo: url(generation, "names")),
        folded: try FileHandle(forWritingTo: url(generation, "folded")),
        origin: origin?.absoluteString)
      draft?.requiresRankedSearch = requiresRankedSearch
      trace.record(TraceEvent(phase: .stage, outcome: .started, snapshot: header.snapshot))
    } catch {
      try removeGeneration(generation)
      throw error
    }
  }

  public func append(_ records: [ArchiveRecord]) throws {
    guard let draft, draft.phase == .staging, let insertContact = draft.insertContact,
      let insertPhone = draft.insertPhone
    else { throw ImportError.invalidSnapshot }
    try Task.checkCancellation()
    guard draft.records + records.count <= draft.header.contacts else {
      throw ImportError.unexpectedCount
    }
    try draft.inserting.measure {
      try insert(records, into: draft, contact: insertContact, phone: insertPhone)
    }
  }

  private func insert(
    _ records: [ArchiveRecord], into draft: SnapshotDraft, contact insertContact: SQLiteStatement,
    phone insertPhone: SQLiteStatement
  ) throws {
    var names = Data()
    var folded = Data()
    for record in records {
      draft.records += 1
      let id = Int64(draft.records)
      var phones = ""
      for phone in record.phones {
        if !phones.isEmpty { phones += "\u{1F}" }
        phones += phone.e164.rawValue + "\u{1E}" + phone.display
      }
      var origin = ""
      for link in record.origin {
        if !origin.isEmpty { origin += "," }
        origin += String(link)
      }
      try insertContact.run([
        .integer(id), .integer(Int64(record.category)), .text(record.region), .text(record.name),
        .text(record.address), .text(phones), record.website.map { .text($0) } ?? .null,
        .integer(Int64(record.provenance)), .text(origin),
        .text(Self.confirmationText(record.confirmation)),
      ])
      for phone in record.phones {
        try insertPhone.run([.integer(phone.e164.number), .integer(id)])
      }
      let normalized = SearchInput.normalizedName(record.name).utf8
      if normalized.contains(0x0A) {
        names.append(contentsOf: normalized.filter { $0 != 0x0A })
      } else {
        names.append(contentsOf: normalized)
      }
      names.append(0x0A)
      // Whitespace folds to single spaces, so a comparison name never holds a line feed.
      folded.append(contentsOf: SearchInput.searchForm(record.name).utf8)
      folded.append(0x0A)
      draft.kinds.append(UInt8(record.category))
      let region =
        draft.regionIndexes[record.region] ?? draft.regionIndexes[record.prefecture] ?? 0
      draft.regions.append(UInt8(truncatingIfNeeded: region))
      draft.regions.append(UInt8(truncatingIfNeeded: region >> 8))
    }
    try draft.names.write(contentsOf: names)
    try draft.folded.write(contentsOf: folded)
  }

  public func publish(at date: Date) throws -> SnapshotManifest {
    try Task.checkCancellation()
    guard let draft, draft.phase == .staging,
      (0...253_402_300_799).contains(date.timeIntervalSince1970)
    else { throw ImportError.invalidSnapshot }
    guard draft.records == draft.header.contacts else { throw ImportError.unexpectedCount }
    guard SearchActivation.permits(required: draft.requiresRankedSearch, ready: draft.searchReady)
    else {
      throw ImportError.invalidSnapshot
    }
    let snapshot = draft.header.snapshot
    trace.record(TraceEvent(phase: .insert, snapshot: snapshot, elapsed: draft.inserting.elapsed))
    try prepareNumbers(draft)
    guard
      PublicationDecision.decide(
        current: !Task.isCancelled, complete: true, snapshot: true, records: true) == .publish
    else { throw CancellationError() }
    var committing = PhaseTimer()
    try committing.measure { try draft.database.execute("COMMIT") }
    trace.record(TraceEvent(phase: .commit, snapshot: snapshot, elapsed: committing.elapsed))
    draft.finalizeStatements()
    try draft.database.close()
    try draft.kinds.write(to: url(draft.generation, "kinds"), options: .withoutOverwriting)
    try draft.regions.write(to: url(draft.generation, "regions"), options: .withoutOverwriting)
    var syncing = PhaseTimer()
    try syncing.measure {
      try draft.names.synchronize()
      try draft.names.close()
      try draft.folded.synchronize()
      try draft.folded.close()
      let database = try FileHandle(forUpdating: url(draft.generation, "sqlite"))
      try database.synchronize()
      try database.close()
    }
    trace.record(TraceEvent(phase: .fsync, snapshot: snapshot, elapsed: syncing.elapsed))
    let previous = try manifest()
    let manifest = SnapshotManifest(
      format: SnapshotManifest.currentFormat, generation: draft.generation,
      previous: previous?.generation, snapshot: draft.header.snapshot,
      generatedAt: draft.header.generatedAt, updatedAt: date, records: draft.records,
      origin: draft.origin, rankedSearch: draft.searchReady ? true : nil)
    let data = try JSONEncoder().encode(manifest)
    draft.phase = draft.phase.applying(.prepare).applying(.beginActivation)
    trace.record(TraceEvent(phase: .activation, outcome: .started, snapshot: snapshot))
    do {
      try files.activateManifest(data, at: manifestURL)
    } catch {
      let visible: SnapshotManifest?
      do { visible = try self.manifest() } catch {
        trace.record(TraceEvent(phase: .activation, outcome: .deferred, snapshot: snapshot))
        throw ImportError.activationUncertain
      }
      guard visible?.generation == manifest.generation else {
        draft.phase = .uncertain.applying(.confirmInactive)
        trace.record(TraceEvent(phase: .activation, outcome: .rejected, snapshot: snapshot))
        throw error
      }
    }
    draft.phase = .uncertain.applying(.confirmActive)
    self.draft = nil
    trace.record(
      TraceEvent(
        phase: .activation, outcome: .completed, snapshot: snapshot,
        records: UInt64(manifest.records)))
    do {
      try cleanup(retaining: Set([manifest.generation, manifest.previous].compactMap { $0 }))
      cleanupPending = false
    } catch {
      cleanupPending = true
      trace.record(TraceEvent(phase: .cleanup, outcome: .deferred, snapshot: snapshot))
    }
    draft.lease.release()
    HeldLocks.current?.forget(draft.lease)
    return manifest
  }

  public func abort() throws {
    guard let draft else { return }
    self.draft = nil
    defer {
      draft.lease.release()
      HeldLocks.current?.forget(draft.lease)
    }
    draft.finalizeStatements()
    try? draft.names.close()
    try? draft.folded.close()
    try draft.database.close()
    if draft.phase.applying(.abort).canDiscard { try removeGeneration(draft.generation) }
  }

  private func removeGeneration(_ generation: UUID) throws {
    for kind in Self.generationExtensions + Self.searchExtensions + Self.mappedSearchExtensions + [
      Self.callerExtension, Self.callerExtension + ".partial",
    ] {
      let target = url(generation, kind)
      if FileManager.default.fileExists(atPath: target.path) {
        try files.removeGeneration(at: target)
      }
    }
  }

  private func cleanup(retaining generations: Set<UUID>) throws {
    for item in try FileManager.default.contentsOfDirectory(
      at: root, includingPropertiesForKeys: nil)
    {
      let name = item.lastPathComponent
      guard let generation = UUID(uuidString: String(name.prefix(36))),
        !generations.contains(generation)
      else { continue }
      indexes[generation] = nil
      try files.removeGeneration(at: item)
    }
  }

  private static func confirmationText(_ value: ArchiveRecord.Confirmation) -> String {
    switch value {
    case .none: ""
    case .unlinked: "*"
    case .link(let index): String(index)
    }
  }

  /// Lists every number once, checks its caller label, and writes the caller file before the generation can activate.
  private func prepareNumbers(_ draft: SnapshotDraft) throws {
    let start = ContinuousClock.now
    var writing = PhaseTimer()
    let database = draft.database
    // The join below reads contacts in number order, so mapped reads replace one read call per row.
    // Mapping starts only now because growing a mapped file during the inserts costs more than it saves.
    try database.execute("PRAGMA mmap_size = 268435456")
    try database.execute("CREATE TABLE numbers (number INTEGER PRIMARY KEY)")
    let insert = try database.prepare("INSERT INTO numbers VALUES (?)")
    let callers = try writing.measure {
      try CallerFile.Writer(url: url(draft.generation, Self.callerExtension))
    }
    let rows = try database.prepare(
      """
      SELECT p.number, c.name, k.label
      FROM phones p JOIN contacts c ON c.id = p.contact JOIN categories k ON k.id = c.category
      ORDER BY p.number, c.id
      """)
    try rows.bind([])
    var labels = CallerLabels()
    var steps = 0
    while let row = try rows.step() {
      steps += 1
      if steps.isMultiple(of: 4096) { try Task.checkCancellation() }
      if let entry = try labels.add(
        number: SQLiteDatabase.integer(row, 0), name: try SQLiteDatabase.text(row, 1),
        category: try SQLiteDatabase.text(row, 2))
      {
        try insert.run([.integer(entry.number)])
        try writing.measure { try callers.append(number: entry.number, label: entry.label) }
      }
    }
    if let entry = try labels.finish() {
      try insert.run([.integer(entry.number)])
      try writing.measure { try callers.append(number: entry.number, label: entry.label) }
    }
    try writing.measure { try callers.finish() }
    let snapshot = draft.header.snapshot
    let numbering = ContinuousClock.now - start - writing.elapsed
    trace.record(TraceEvent(phase: .numbers, snapshot: snapshot, elapsed: numbering))
    trace.record(TraceEvent(phase: .callers, snapshot: snapshot, elapsed: writing.elapsed))
  }

  /// The file that the Call Directory extension reads for a generation.
  public func callerFile(generation: UUID) -> URL { url(generation, Self.callerExtension) }

  /// Writes the caller file of a generation saved before the app wrote one, and returns its location.
  @discardableResult
  public func ensureCallerFile(generation: UUID) throws -> URL {
    let target = callerFile(generation: generation)
    if FileManager.default.fileExists(atPath: target.path) { return target }
    let partial = url(generation, Self.callerExtension + ".partial")
    let writer = try CallerFile.Writer(url: partial)
    var previous: Int64 = 0
    while true {
      let entries = try identification(generation: generation, after: previous)
      guard let last = entries.last else { break }
      for entry in entries { try writer.append(number: entry.number, label: entry.label) }
      previous = last.number
    }
    try writer.finish()
    try FileManager.default.moveItem(at: partial, to: target)
    return target
  }

  private func readable(_ generation: UUID?) throws -> (SQLiteDatabase, UUID) {
    guard let active = try manifest() else { throw ImportError.unavailableStorage }
    let generation = generation ?? active.generation
    guard generation == active.generation || generation == active.previous else {
      throw ImportError.invalidSnapshot
    }
    return (try SQLiteDatabase(url: url(generation, "sqlite"), readOnly: true), generation)
  }

  private func index(_ database: SQLiteDatabase, _ generation: UUID) throws -> ArchiveIndex {
    if let cached = indexes[generation] { return cached }
    let text = try database.query("SELECT value FROM meta WHERE key = 'header'") {
      try SQLiteDatabase.text($0, 0, maximumBytes: 67_108_864)
    }
    guard let first = text.first else { throw ImportError.invalidSnapshot }
    let header = try JSONDecoder().decode(ArchiveHeader.self, from: Data(first.utf8))
    let index = ArchiveIndex(header: header)
    indexes[generation] = index
    return index
  }

  public func header(generation: UUID) throws -> ArchiveHeader {
    let (database, generation) = try readable(generation)
    return try index(database, generation).header
  }

  public func searchIndex(generation: UUID) throws -> LocalSearch {
    let (database, generation) = try readable(generation)
    return try LocalSearch(
      names: url(generation, "names"), folded: url(generation, "folded"),
      kinds: url(generation, "kinds"), regions: url(generation, "regions"),
      places: index(database, generation).header.searchPlaces)
  }

  private struct SearchKey: Hashable {
    let name: Data
    let category: String
    let region: String
    let phones: [String]
  }

  private struct SavedSearchManifest: Codable {
    let format: String
    let artifacts: SearchArtifactManifest
    let rowsSha256: SnapshotID
    let linesSha256: SnapshotID?
  }

  private static func searchDigest(_ data: Data) throws -> SnapshotID {
    try SnapshotID(SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined())
  }

  public func installSearch(_ artifacts: SearchArtifactFiles) throws {
    guard let draft, draft.phase == .staging, draft.records == draft.header.contacts,
      artifacts.manifest.snapshot == draft.header.snapshot,
      artifacts.manifest.contacts == draft.records, !draft.searchReady
    else { throw ImportError.invalidSnapshot }
    try Task.checkCancellation()
    let admitted = try artifacts.admit()
    let statement = try draft.database.prepare(
      "SELECT id, name, category, region, phones FROM contacts ORDER BY id DESC")
    try statement.bind([])
    var available: [SearchKey: [UInt32]] = [:]
    while let row = try statement.step() {
      let category = Int(SQLiteDatabase.integer(row, 2))
      guard draft.header.categories.indices.contains(category) else {
        throw ImportError.invalidRecord
      }
      let phones = try SQLiteDatabase.text(row, 4).split(separator: "\u{1F}").map {
        String($0.split(separator: "\u{1E}", maxSplits: 1)[0])
      }.sorted()
      let key = SearchKey(
        name: Data(try SQLiteDatabase.text(row, 1).utf8),
        category: draft.header.categories[category].id, region: try SQLiteDatabase.text(row, 3),
        phones: phones)
      let id = SQLiteDatabase.integer(row, 0)
      guard id > 0, id <= draft.records else { throw ImportError.invalidRecord }
      available[key, default: []].append(UInt32(id))
    }
    var mapping = Data()
    mapping.reserveCapacity(draft.records * 4)
    for (position, row) in admitted.index.rows.enumerated() {
      if position.isMultiple(of: 4096) { try Task.checkCancellation() }
      let phones = try row.phones.map { phone in
        guard let canonical = SearchInput.normalizedPhone(phone) else {
          throw ImportError.invalidRecord
        }
        return canonical
      }.sorted()
      let key = SearchKey(
        name: Data(row.name.utf8), category: row.category, region: row.region, phones: phones)
      guard let id = available[key]?.popLast() else { throw RankingError.identityMismatch }
      if available[key]?.isEmpty == true { available[key] = nil }
      var littleEndian = id.littleEndian
      Swift.withUnsafeBytes(of: &littleEndian) { mapping.append(contentsOf: $0) }
    }
    guard available.isEmpty else { throw RankingError.identityMismatch }
    let viewed = try SearchArtifacts.index(admitted.indexBytes, lazy: true)
    guard let lines = viewed.lineOffsets else { throw RankingError.invalidArtifact }
    try admitted.indexBytes.write(
      to: url(draft.generation, "search-index"), options: .withoutOverwriting)
    try admitted.rankingBytes.write(
      to: url(draft.generation, "search-ranking"), options: .withoutOverwriting)
    try lines.write(to: url(draft.generation, "search-lines"), options: .withoutOverwriting)
    let saved = try SavedSearchManifest(
      format: "public-phonebook-saved-search/2", artifacts: artifacts.manifest,
      rowsSha256: Self.searchDigest(mapping), linesSha256: Self.searchDigest(lines))
    try JSONEncoder().encode(saved).write(
      to: url(draft.generation, "search.json"), options: .withoutOverwriting)
    try mapping.write(to: url(draft.generation, "search-rows"), options: .withoutOverwriting)
    for kind in Self.mappedSearchExtensions {
      let handle = try FileHandle(forUpdating: url(draft.generation, kind))
      try handle.synchronize()
      try handle.close()
    }
    draft.searchReady = true
  }

  public func rankedSearch(generation: UUID) throws -> SavedRankedSearch? {
    let (database, generation) = try readable(generation)
    let manifestFile = url(generation, "search.json")
    guard FileManager.default.fileExists(atPath: manifestFile.path) else { return nil }
    let bytes = try LocalSnapshotFiles().readManifest(at: manifestFile)
    guard bytes.count <= 65_536 else { throw RankingError.invalidArtifact }
    let saved = try JSONDecoder().decode(SavedSearchManifest.self, from: bytes)
    guard
      ["public-phonebook-saved-search/1", "public-phonebook-saved-search/2"].contains(saved.format)
    else {
      throw RankingError.invalidArtifact
    }
    let header = try index(database, generation).header
    try saved.artifacts.validate()
    guard saved.artifacts.snapshot == header.snapshot, saved.artifacts.contacts == header.contacts
    else {
      throw RankingError.identityMismatch
    }
    let scorer: RankedSearch
    if saved.format == "public-phonebook-saved-search/2" {
      guard let linesSha256 = saved.linesSha256 else { throw RankingError.invalidArtifact }
      let indexBytes = try saved.artifacts.index.mapped(url(generation, "search-index"))
      let rankingBytes = try saved.artifacts.ranking.mapped(url(generation, "search-ranking"))
      let lines = try SearchArtifactIdentity.mapped(
        url(generation, "search-lines"), bytes: (header.contacts + 1) * 8, sha256: linesSha256)
      let viewed = try SearchArtifacts.index(indexBytes, lazy: true, lineOffsets: lines)
      let ranking = try SearchArtifacts.ranking(
        rankingBytes, snapshot: header.snapshot.rawValue, contacts: header.contacts,
        completeValidation: false)
      scorer = try viewed.scorer(ranking)
    } else {
      let files = try SearchArtifactFiles(
        manifest: saved.artifacts, index: url(generation, "search-index.br"),
        ranking: url(generation, "search-ranking.br"))
      let admitted = try files.admit()
      scorer = try admitted.index.scorer(admitted.ranking)
    }
    let handle = try FileHandle(forReadingFrom: url(generation, "search-rows"))
    defer { try? handle.close() }
    let data = try handle.read(upToCount: header.contacts * 4 + 1) ?? Data()
    guard data.count == header.contacts * 4, try Self.searchDigest(data) == saved.rowsSha256 else {
      throw RankingError.invalidArtifact
    }
    let ids = data.withUnsafeBytes { raw in
      (0..<header.contacts).map {
        UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: $0 * 4, as: UInt32.self))
      }
    }
    var seen = [UInt8](repeating: 0, count: header.contacts + 1)
    for id in ids {
      guard id > 0, Int(id) <= header.contacts, seen[Int(id)] == 0 else {
        throw RankingError.invalidArtifact
      }
      seen[Int(id)] = 1
    }
    return SavedRankedSearch(scorer: scorer, ids: ids)
  }

  public func searchUsesMappedFiles(generation: UUID) -> Bool {
    Self.mappedSearchExtensions.allSatisfy {
      FileManager.default.fileExists(atPath: url(generation, $0).path)
    }
  }

  /// The most saved rows that one call returns, which bounds the memory of copying a national base.
  public static let archiveRowBatch = 4096

  /// Writes saved rows back as archive lines, where each row `id` is its archive position plus one.
  public func archiveRows(generation: UUID, from start: Int, count: Int) throws -> [Data] {
    guard start >= 0, (1...Self.archiveRowBatch).contains(count) else {
      throw ImportError.invalidRecord
    }
    let (database, _) = try readable(generation)
    let rows = try database.query(
      """
      SELECT category, region, name, address, phones, website, provenance, origin, confirmation
      FROM contacts WHERE id > ? AND id <= ? ORDER BY id
      """, [.integer(Int64(start)), .integer(Int64(start + count))]
    ) { try Self.archiveLine($0) }
    // Row identifiers are distinct integers, so `count` rows in the range are every position in it.
    guard rows.count == count else { throw ImportError.invalidSnapshot }
    return rows
  }

  private static func archiveLine(_ row: OpaquePointer) throws -> Data {
    let phones = try SQLiteDatabase.text(row, 4).split(separator: "\u{1F}").map { item in
      let parts = item.split(separator: "\u{1E}", maxSplits: 1, omittingEmptySubsequences: false)
      guard parts.count == 2 else { throw ImportError.invalidRecord }
      return ArchiveRecord.telephone(e164: parts[0], display: parts[1])
    }
    let fields = [
      String(SQLiteDatabase.integer(row, 0)), try SQLiteDatabase.text(row, 1),
      try SQLiteDatabase.text(row, 2), try SQLiteDatabase.text(row, 3),
      phones.joined(separator: "\u{1F}"), try SQLiteDatabase.optionalText(row, 5) ?? "",
      String(SQLiteDatabase.integer(row, 6)),
      try SQLiteDatabase.text(row, 7).replacingOccurrences(of: ",", with: "\u{1F}"),
      try SQLiteDatabase.text(row, 8),
    ]
    return Data(fields.joined(separator: "\t").utf8)
  }

  public func contactIDs(generation: UUID, number: Int64) throws -> [Int64] {
    let (database, _) = try readable(generation)
    return try database.query(
      "SELECT contact FROM phones WHERE number = ? ORDER BY contact LIMIT 4096", [.integer(number)]
    ) { SQLiteDatabase.integer($0, 0) }
  }

  public func contacts(generation: UUID, ids: [Int64]) throws -> [Contact] {
    guard ids.count <= 500 else { throw ImportError.invalidRecord }
    guard !ids.isEmpty else { return [] }
    let (database, generation) = try readable(generation)
    let index = try index(database, generation)
    let placeholders = Array(repeating: "?", count: ids.count).joined(separator: ",")
    let rows = try database.query(
      """
      SELECT id, category, region, name, address, phones, website, provenance, origin, confirmation
      FROM contacts WHERE id IN (\(placeholders))
      """, ids.map { .integer($0) }
    ) { try Self.contact($0, index: index) }
    let byID = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
    return ids.compactMap { byID[$0] }
  }

  private static func contact(_ row: OpaquePointer, index: ArchiveIndex) throws -> Contact {
    let header = index.header
    let category = Int(SQLiteDatabase.integer(row, 1))
    let provenance = Int(SQLiteDatabase.integer(row, 7))
    let region = try SQLiteDatabase.text(row, 2)
    let origin = try SQLiteDatabase.text(row, 8).split(separator: ",").compactMap { Int($0) }
    guard header.categories.indices.contains(category),
      header.provenances.indices.contains(provenance),
      origin.allSatisfy(header.links.indices.contains)
    else { throw ImportError.invalidRecord }
    let entry = header.provenances[provenance]
    let source = header.sources[entry.source]
    let confirmation = try SQLiteDatabase.text(row, 9)
    let phones = try SQLiteDatabase.text(row, 5).split(separator: "\u{1F}").map { item in
      let parts = item.split(separator: "\u{1E}", maxSplits: 1, omittingEmptySubsequences: false)
      guard parts.count == 2 else { throw ImportError.invalidRecord }
      return Phone(display: String(parts[1]), e164: try CanonicalPhone(String(parts[0])))
    }
    return Contact(
      id: SQLiteDatabase.integer(row, 0), name: try SQLiteDatabase.text(row, 3),
      categoryKey: header.categories[category].id, category: header.categories[category].label,
      prefecture: index.prefectures[String(region.prefix(2))] ?? "",
      municipality: region.count == 5 ? index.municipalities[region] : nil,
      address: try SQLiteDatabase.text(row, 4), phones: phones,
      website: try SQLiteDatabase.optionalText(row, 6),
      provenance: Provenance(
        publisher: source.publisher ?? header.categories[category].publisher,
        sourceURL: source.url, publications: origin.map { header.links[$0] },
        license: entry.license, licenseURL: entry.licenseUrl, dataAsOf: entry.dataAsOf,
        retrievedAt: entry.retrievedAt, confirmed: !confirmation.isEmpty,
        confirmationURL: Int(confirmation).flatMap {
          header.links.indices.contains($0) ? header.links[$0] : nil
        }))
  }

  public func identification(generation: UUID, after number: Int64, limit: Int = 1000) throws
    -> [IdentificationEntry]
  {
    guard number >= 0, (1...1000).contains(limit) else { throw ImportError.invalidRecord }
    let (database, _) = try readable(generation)
    let rows = try database.prepare(
      """
      SELECT p.number, c.name, k.label FROM phones p
      JOIN contacts c ON c.id = p.contact JOIN categories k ON k.id = c.category
      WHERE p.number IN (SELECT number FROM numbers WHERE number > ? ORDER BY number LIMIT ?)
      ORDER BY p.number, c.id
      """)
    try rows.bind([.integer(number), .integer(Int64(limit))])
    var entries: [IdentificationEntry] = []
    var labels = CallerLabels()
    while let row = try rows.step() {
      if let entry = try labels.add(
        number: SQLiteDatabase.integer(row, 0), name: try SQLiteDatabase.text(row, 1),
        category: try SQLiteDatabase.text(row, 2))
      {
        entries.append(entry)
      }
    }
    if let entry = try labels.finish() { entries.append(entry) }
    return entries
  }
}
