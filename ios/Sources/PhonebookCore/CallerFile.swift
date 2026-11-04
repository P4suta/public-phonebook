import Foundation

/// The caller label of every number in one saved directory, in ascending number order.
///
/// The Call Directory extension may use only 12 MB, so it reads this file with a fixed buffer instead of opening the directory database.
/// After the header, each record holds the number's increase over the previous number, the label's UTF-8 length, and the label.
/// Both integers are unsigned LEB128, and the first number counts up from zero.
public enum CallerFile {
  public static let header = Array("public-phonebook-callers\t1\n".utf8)
  public static let maximumLabelBytes = 1024
  static let maximumRecordBytes = 10 + 2 + maximumLabelBytes

  public enum Failure: Error, Equatable {
    case header, order, truncated, label
  }

  /// Writes records as they arrive and keeps at most one buffer of them in memory.
  public final class Writer {
    private let handle: FileHandle
    private var buffer: [UInt8] = []
    private var previous: Int64 = 0
    public private(set) var count = 0

    /// Creates or replaces the file at `url`.
    public init(url: URL) throws {
      guard FileManager.default.createFile(atPath: url.path, contents: Data(CallerFile.header))
      else { throw CocoaError(.fileWriteUnknown) }
      handle = try FileHandle(forWritingTo: url)
      try handle.seekToEnd()
    }

    public func append(number: Int64, label: String) throws {
      let bytes = Array(label.utf8)
      guard number > previous else { throw Failure.order }
      guard !bytes.isEmpty, bytes.count <= CallerFile.maximumLabelBytes else {
        throw Failure.label
      }
      CallerFile.appendVarint(UInt64(number - previous), to: &buffer)
      CallerFile.appendVarint(UInt64(bytes.count), to: &buffer)
      buffer.append(contentsOf: bytes)
      previous = number
      count += 1
      if buffer.count >= 65_536 { try flush() }
    }

    /// Writes the remaining records and makes them durable before the caller publishes the file.
    public func finish() throws {
      try flush()
      try handle.synchronize()
      try handle.close()
    }

    private func flush() throws {
      guard !buffer.isEmpty else { return }
      try handle.write(contentsOf: buffer)
      buffer.removeAll(keepingCapacity: true)
      // Records left behind would be written again at every later flush, so a debug build stops at once.
      assert(buffer.isEmpty, "A flush leaves no records in the buffer")
    }
  }

  /// Reads records through a fixed-size buffer, so its memory doesn't grow with the file.
  public final class Reader {
    private let handle: FileHandle
    private let chunk: Int
    private var buffer: [UInt8] = []
    private var position = 0
    private var ended = false
    private var previous: Int64 = 0
    /// The most bytes the buffer has held at once, which stays under `bufferLimit` however long the file is.
    public private(set) var peakBufferedBytes = 0
    /// A refill starts with fewer unread bytes than one record or the header and adds at most one chunk.
    public var bufferLimit: Int {
      chunk + max(CallerFile.maximumRecordBytes, CallerFile.header.count)
    }

    public init(url: URL, chunk: Int = 65_536) throws {
      handle = try FileHandle(forReadingFrom: url)
      self.chunk = max(chunk, CallerFile.maximumRecordBytes)
      try fill(CallerFile.header.count)
      guard buffer.count >= CallerFile.header.count,
        Array(buffer[0..<CallerFile.header.count]) == CallerFile.header
      else { throw Failure.header }
      position = CallerFile.header.count
    }

    deinit { try? handle.close() }

    /// Passes up to `limit` records to `body` in number order and returns how many it passed, or 0 at the end.
    public func read(upTo limit: Int, _ body: (Int64, String) -> Void) throws -> Int {
      var passed = 0
      while passed < limit {
        try fill(CallerFile.maximumRecordBytes)
        guard position < buffer.count else { break }
        let delta = try varint()
        let length = try varint()
        guard delta > 0, delta <= UInt64(Int64.max - previous) else { throw Failure.order }
        guard length > 0, length <= UInt64(CallerFile.maximumLabelBytes) else {
          throw Failure.label
        }
        guard buffer.count - position >= Int(length) else { throw Failure.truncated }
        guard
          let label = String(
            validating: buffer[position..<position + Int(length)], as: UTF8.self)
        else { throw Failure.label }
        position += Int(length)
        previous += Int64(delta)
        body(previous, label)
        passed += 1
      }
      return passed
    }

    private func varint() throws -> UInt64 {
      var value: UInt64 = 0
      for shift in stride(from: 0, to: 64, by: 7) {
        guard position < buffer.count else { throw Failure.truncated }
        let byte = buffer[position]
        position += 1
        value |= UInt64(byte & 0x7F) << UInt64(shift)
        if byte & 0x80 == 0 { return value }
      }
      throw Failure.truncated
    }

    /// Keeps at least `bytes` unread bytes in the buffer unless the file ends first.
    private func fill(_ bytes: Int) throws {
      guard buffer.count - position < bytes, !ended else { return }
      buffer.removeSubrange(0..<position)
      position = 0
      while buffer.count < bytes, !ended {
        guard let data = try handle.read(upToCount: chunk), !data.isEmpty else {
          ended = true
          break
        }
        buffer.append(contentsOf: data)
        peakBufferedBytes = max(peakBufferedBytes, buffer.count)
      }
    }
  }

  /// Passes the national records and one extra entry in ascending number order, as `verification/ios/CallerMerge.lean` models.
  /// The extra label replaces the national label of the same number, because CallKit takes each number once.
  public final class Merged {
    private let national: Reader?
    private var extra: Loaded.Extra?

    public init(national: Reader?, extra: CallerEntry?) {
      self.national = national
      self.extra = extra.map { Loaded.Extra(number: $0.phone.number, label: $0.label) }
    }

    /// Merges the extra entry of a loaded record, which already holds the number and the label.
    public init(national: Reader?, loaded extra: Loaded.Extra?) {
      self.national = national
      self.extra = extra
    }

    /// Reads up to `limit` national records, passes them with the extra entry where it belongs, and returns how many entries it passed, or 0 at the end.
    public func read(upTo limit: Int, _ body: (Int64, String) -> Void) throws -> Int {
      var passed = 0
      let read =
        try national?.read(upTo: limit) { number, label in
          guard let pending = extra else {
            body(number, label)
            passed += 1
            return
          }
          switch CallerMerge.decide(extra: pending.number, national: number) {
          case .national:
            body(number, label)
            passed += 1
          case .extraFirst:
            body(pending.number, pending.label)
            body(number, label)
            passed += 2
            extra = nil
          case .extraReplaces:
            body(pending.number, pending.label)
            passed += 1
            extra = nil
          }
        } ?? 0
      if read == 0, let pending = extra {
        extra = nil
        body(pending.number, pending.label)
        return 1
      }
      return passed
    }
  }

  public struct Active: Equatable, Sendable {
    public let generation: UUID
    public let file: URL

    public init(generation: UUID, file: URL) {
      self.generation = generation
      self.file = file
    }
  }

  /// Finds the caller file of the active generation in a saved directory, or nil before the app has written one.
  public static func active(in directory: URL) throws -> Active? {
    struct Manifest: Decodable { let generation: UUID }
    let manifest = directory.appendingPathComponent("active.json")
    guard FileManager.default.fileExists(atPath: manifest.path) else { return nil }
    let generation = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: manifest))
      .generation
    let file = directory.appendingPathComponent(generation.uuidString + ".callers")
    return FileManager.default.fileExists(atPath: file.path)
      ? Active(generation: generation, file: file) : nil
  }

  private static func loadedRecord(in directory: URL) -> URL {
    directory.appendingPathComponent("callers-loaded")
  }

  /// What iOS holds after the extension's last accepted load: one generation's caller file and the extra entry.
  public struct Loaded: Codable, Equatable, Sendable {
    public struct Extra: Codable, Equatable, Sendable {
      public let number: Int64
      public let label: String

      public init(number: Int64, label: String) {
        self.number = number
        self.label = label
      }
    }

    public let generation: UUID?
    public let extra: Extra?

    public init(generation: UUID?, extra: Extra?) {
      self.generation = generation
      self.extra = extra
    }
  }

  /// Records what iOS accepted from the extension, so the app doesn't ask iOS to load the same generation again and the next load can send the difference.
  public static func recordLoaded(_ loaded: Loaded, in directory: URL) throws {
    try JSONEncoder().encode(loaded).write(to: loadedRecord(in: directory), options: .atomic)
  }

  /// What iOS last accepted, or nil when it never accepted a load or an earlier app wrote the record without the extra entry.
  public static func loaded(in directory: URL) -> Loaded? {
    (try? Data(contentsOf: loadedRecord(in: directory))).flatMap {
      try? JSONDecoder().decode(Loaded.self, from: $0)
    }
  }

  /// The generation that iOS last accepted from the extension, or nil when it never accepted one.
  /// An earlier app wrote the generation alone as text, and that record still names it.
  public static func loadedGeneration(in directory: URL) -> UUID? {
    if let loaded = loaded(in: directory) { return loaded.generation }
    return (try? String(contentsOf: loadedRecord(in: directory), encoding: .utf8)).flatMap(
      UUID.init(uuidString:))
  }

  /// The national entries that a loaded record names.
  public enum Held: Equatable, Sendable {
    /// The record names no generation, so iOS holds the extra entry alone.
    case none
    case file(URL)
    /// The store no longer keeps the named generation's caller file.
    case missing
  }

  public static func held(_ loaded: Loaded, in directory: URL) -> Held {
    guard let generation = loaded.generation else { return .none }
    let file = directory.appendingPathComponent(generation.uuidString + ".callers")
    return FileManager.default.fileExists(atPath: file.path) ? .file(file) : .missing
  }

  /// Passes the entries of a merged reader one at a time through one batch, so two walks stay within a fixed amount of memory.
  final class Cursor {
    private let merged: Merged
    private var batch: [(Int64, String)] = []
    private var index = 0

    private let size: Int

    init(_ merged: Merged, batch: Int) {
      self.merged = merged
      size = max(batch, 1)
    }

    func peek() throws -> (Int64, String)? {
      if index == batch.count {
        batch.removeAll(keepingCapacity: true)
        index = 0
        _ = try merged.read(upTo: size) { batch.append(($0, $1)) }
      }
      return index < batch.count ? batch[index] : nil
    }

    func advance() { index += 1 }
  }

  /// Walks two ascending merged readers as `diffCallers` in `verification/ios/CallerDelta.lean` does, and reports each removal or addition.
  static func walk(
    held: Merged, wanted: Merged, batch: Int, remove: (Int64) -> Void,
    add: (Int64, String) -> Void
  ) throws {
    let held = Cursor(held, batch: batch)
    let wanted = Cursor(wanted, batch: batch)
    while true {
      switch (try held.peek(), try wanted.peek()) {
      case (nil, nil): return
      case (let entry?, nil):
        remove(entry.0)
        held.advance()
      case (nil, let entry?):
        add(entry.0, entry.1)
        wanted.advance()
      case (let old?, let new?):
        switch CallerChange.decide(held: old.0, heldLabel: old.1, wanted: new.0, wantedLabel: new.1)
        {
        case .remove:
          remove(old.0)
          held.advance()
        case .add:
          add(new.0, new.1)
          wanted.advance()
        case .keep:
          held.advance()
          wanted.advance()
        case .replace:
          remove(old.0)
          add(new.0, new.1)
          held.advance()
          wanted.advance()
        }
      }
    }
  }

  /// Passes every number to remove and then every entry to add, which turn the entries that iOS holds into the wanted ones.
  /// Each pass opens its own readers from the factories, so both passes read the two lists from the start.
  public static func changes(
    held: () throws -> Merged, wanted: () throws -> Merged, batch: Int = 1000,
    remove: (Int64) -> Void,
    add: (Int64, String) -> Void
  ) throws {
    try walk(held: held(), wanted: wanted(), batch: batch, remove: remove, add: { _, _ in })
    try walk(held: held(), wanted: wanted(), batch: batch, remove: { _ in }, add: add)
  }

  /// A UInt64 has at most ten 7-bit groups, so the loop ends after ten bytes whatever its exit test says.
  static func appendVarint(_ value: UInt64, to bytes: inout [UInt8]) {
    var value = value
    for _ in 0..<10 {
      let low = UInt8(value & 0x7F)
      value >>= 7
      bytes.append(value == 0 ? low : low | 0x80)
      if value == 0 { return }
    }
  }
}
