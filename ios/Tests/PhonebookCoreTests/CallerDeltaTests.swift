import Foundation
import Testing

@testable import PhonebookCore

private func temporaryDirectory() throws -> URL {
  let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
  return url
}

private func write(_ entries: [(Int64, String)], to url: URL) throws {
  let writer = try CallerFile.Writer(url: url)
  for (number, label) in entries { try writer.append(number: number, label: label) }
  try writer.finish()
}

/// The `diffCallers` function of `verification/ios/CallerDelta.lean`, transcribed case for case.
private func model(_ held: [(Int64, String)], _ wanted: [(Int64, String)]) -> (
  [Int64], [(Int64, String)]
) {
  guard let old = held.first else { return ([], wanted) }
  guard let new = wanted.first else { return (held.map(\.0), []) }
  let olds = Array(held.dropFirst())
  let news = Array(wanted.dropFirst())
  switch CallerChange.decide(held: old.0, heldLabel: old.1, wanted: new.0, wantedLabel: new.1) {
  case .remove:
    let rest = model(olds, wanted)
    return ([old.0] + rest.0, rest.1)
  case .add:
    let rest = model(held, news)
    return (rest.0, [new] + rest.1)
  case .keep: return model(olds, news)
  case .replace:
    let rest = model(olds, news)
    return ([old.0] + rest.0, [new] + rest.1)
  }
}

/// Streams the changes between two caller files with an optional extra entry each.
private func streamed(
  held: [(Int64, String)], heldExtra: CallerFile.Loaded.Extra?, wanted: [(Int64, String)],
  wantedExtra: CallerFile.Loaded.Extra?, batch: Int = 1000, chunk: Int = 65_536
) throws -> ([Int64], [(Int64, String)]) {
  let directory = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: directory) }
  let heldFile = directory.appendingPathComponent("held.callers")
  let wantedFile = directory.appendingPathComponent("wanted.callers")
  try write(held, to: heldFile)
  try write(wanted, to: wantedFile)
  var removed: [Int64] = []
  var added: [(Int64, String)] = []
  try CallerFile.changes(
    held: {
      CallerFile.Merged(
        national: try CallerFile.Reader(url: heldFile, chunk: chunk), loaded: heldExtra)
    },
    wanted: {
      CallerFile.Merged(
        national: try CallerFile.Reader(url: wantedFile, chunk: chunk), loaded: wantedExtra)
    }, batch: batch, remove: { removed.append($0) }, add: { added.append(($0, $1)) })
  return (removed, added)
}

/// The entries that a merged reader passes.
private func merged(_ entries: [(Int64, String)], _ extra: CallerFile.Loaded.Extra?) throws
  -> [(Int64, String)]
{
  let directory = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: directory) }
  let file = directory.appendingPathComponent("entries.callers")
  try write(entries, to: file)
  let reader = CallerFile.Merged(national: try CallerFile.Reader(url: file), loaded: extra)
  var passed: [(Int64, String)] = []
  while try reader.read(upTo: 1000, { passed.append(($0, $1)) }) > 0 {}
  return passed
}

private struct SplitMix64 {
  private var state: UInt64
  init(seed: UInt64) { state = seed }
  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var value = state
    value = (value ^ (value >> 30)) &* 0xBF58_476D_1CE4_E5B9
    value = (value ^ (value >> 27)) &* 0x94D0_49BB_1331_11EB
    return value ^ (value >> 31)
  }
}

private func entries(_ random: inout SplitMix64, labels: [String]) -> [(Int64, String)] {
  var result: [(Int64, String)] = []
  var number: Int64 = 81_300_000_000
  for _ in 0..<Int(random.next() % 40) {
    number += Int64(random.next() % 3) + 1
    result.append((number, labels[Int(random.next() % UInt64(labels.count))]))
  }
  return result
}

@Test func callerChangeDecisionFollowsTheNumbersAndTheLabelBytes() {
  let values: [Int64] = [.min, -1, 0, 1, 81_300_000_000, .max]
  for held in values {
    for wanted in values {
      for (heldLabel, wantedLabel) in [("図書館", "図書館"), ("図書館", "公民館")] {
        let expected: CallerChange =
          held < wanted
          ? .remove : wanted < held ? .add : heldLabel == wantedLabel ? .keep : .replace
        #expect(
          CallerChange.decide(
            held: held, heldLabel: heldLabel, wanted: wanted, wantedLabel: wantedLabel)
            == expected)
      }
    }
  }
  // Canonically equivalent labels with different bytes are different labels to CallKit.
  #expect(
    CallerChange.decide(held: 1, heldLabel: "\u{30AC}", wanted: 1, wantedLabel: "\u{30AB}\u{3099}")
      == .replace)
}

@Test(arguments: 0..<200)
func streamedChangesMatchTheLeanModelOnSeededInputs(seed: Int) throws {
  var random = SplitMix64(seed: UInt64(seed))
  let labels = ["図書館", "公民館", "保健所", "役所（窓口）"]
  let held = entries(&random, labels: labels)
  let wanted = entries(&random, labels: labels)
  func extra() -> CallerFile.Loaded.Extra? {
    random.next() % 3 == 0
      ? nil
      : CallerFile.Loaded.Extra(number: 81_300_000_000 + Int64(random.next() % 140), label: "確認用")
  }
  let heldExtra = extra()
  let wantedExtra = extra()
  let heldEntries = try merged(held, heldExtra)
  let wantedEntries = try merged(wanted, wantedExtra)
  let expected = model(heldEntries, wantedEntries)
  let actual = try streamed(
    held: held, heldExtra: heldExtra, wanted: wanted, wantedExtra: wantedExtra,
    batch: Int(random.next() % 5) + 1, chunk: Int(random.next() % 64) + 1)
  #expect(actual.0 == expected.0)
  #expect(actual.1.map(\.0) == expected.1.map(\.0))
  #expect(actual.1.map(\.1) == expected.1.map(\.1))
  // Applying the removals and then the additions to the held entries yields the wanted entries.
  var map = Dictionary(uniqueKeysWithValues: heldEntries)
  for number in actual.0 { map[number] = nil }
  for (number, label) in actual.1 {
    #expect(map[number] == nil)
    map[number] = label
  }
  #expect(map == Dictionary(uniqueKeysWithValues: wantedEntries))
  #expect(zip(actual.1, actual.1.dropFirst()).allSatisfy { $0.0 < $1.0 })
  #expect(zip(actual.0, actual.0.dropFirst()).allSatisfy { $0 < $1 })
}

@Test func aChangedTestEntryAloneCostsAtMostTwoRemovalsAndTwoAdditions() throws {
  let national: [(Int64, String)] = [(81_300_000_001, "図書館"), (81_300_000_005, "公民館")]
  let pairs: [(CallerFile.Loaded.Extra?, CallerFile.Loaded.Extra?)] = [
    (nil, CallerFile.Loaded.Extra(number: 81_300_000_003, label: "確認用")),
    (
      CallerFile.Loaded.Extra(number: 81_300_000_001, label: "確認用"),
      CallerFile.Loaded.Extra(number: 81_300_000_005, label: "確認用")
    ),
    (CallerFile.Loaded.Extra(number: 81_300_000_005, label: "確認用"), nil),
    (
      CallerFile.Loaded.Extra(number: 81_300_000_003, label: "確認用"),
      CallerFile.Loaded.Extra(number: 81_300_000_003, label: "別の名前")
    ),
  ]
  for (old, new) in pairs {
    let changes = try streamed(held: national, heldExtra: old, wanted: national, wantedExtra: new)
    #expect(changes.0.count <= 2 && changes.1.count <= 2)
  }
  let same = try streamed(held: national, heldExtra: nil, wanted: national, wantedExtra: nil)
  #expect(same.0.isEmpty && same.1.isEmpty)
}

@Test func theLoadedRecordNamesWhatIOSHoldsAndReadsTheEarlierText() throws {
  let directory = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: directory) }
  #expect(CallerFile.loaded(in: directory) == nil)
  let generation = UUID()
  try Data(generation.uuidString.utf8).write(
    to: directory.appendingPathComponent("callers-loaded"))
  // An earlier record names its generation but not the extra entry, so the next load sends everything.
  #expect(CallerFile.loaded(in: directory) == nil)
  #expect(CallerFile.loadedGeneration(in: directory) == generation)
  let record = CallerFile.Loaded(
    generation: generation, extra: CallerFile.Loaded.Extra(number: 81_300_000_003, label: "確認用"))
  try CallerFile.recordLoaded(record, in: directory)
  #expect(CallerFile.loaded(in: directory) == record)
  #expect(CallerFile.loadedGeneration(in: directory) == generation)
  #expect(CallerFile.held(record, in: directory) == .missing)
  let file = directory.appendingPathComponent(generation.uuidString + ".callers")
  try write([(81_300_000_001, "図書館")], to: file)
  #expect(CallerFile.held(record, in: directory) == .file(file))
  #expect(CallerFile.held(CallerFile.Loaded(generation: nil, extra: nil), in: directory) == .none)
}
