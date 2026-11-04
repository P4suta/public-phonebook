import Foundation
import Testing

@testable import PhonebookCore

private func temporaryFile(_ key: String) -> URL { callerFile(key) }

private func write(_ entries: [(Int64, String)], to url: URL) throws {
  let writer = try CallerFile.Writer(url: url)
  for (number, label) in entries { try writer.append(number: number, label: label) }
  try writer.finish()
}

private func merged(
  _ national: [(Int64, String)]?, extra: CallerEntry?, chunk: Int = 65_536, batch: Int = 1000,
  key: String = #function
) throws -> [(Int64, String)] {
  var reader: CallerFile.Reader?
  var url: URL?
  if let national {
    let file = temporaryFile(key)
    try write(national, to: file)
    reader = try CallerFile.Reader(url: file, chunk: chunk)
    url = file
  }
  defer { if let url { try? FileManager.default.removeItem(at: url) } }
  let merge = CallerFile.Merged(national: reader, extra: extra)
  var entries: [(Int64, String)] = []
  while try merge.read(upTo: batch, { entries.append(($0, $1)) }) > 0 {}
  return entries
}

/// The `mergeCallers` function of `verification/ios/CallerMerge.lean`, transcribed case for case.
private func model(_ extra: (Int64, String)?, _ national: [(Int64, String)]) -> [(Int64, String)] {
  guard let extra else { return national }
  guard let entry = national.first else { return [extra] }
  let rest = Array(national.dropFirst())
  switch CallerMerge.decide(extra: extra.0, national: entry.0) {
  case .national: return [entry] + model(extra, rest)
  case .extraFirst: return [extra, entry] + rest
  case .extraReplaces: return [extra] + rest
  }
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

private func fixture(_ telephone: String, _ label: String = "確認用の番号") throws -> CallerEntry {
  try CallerEntry(telephone: telephone, label: label)
}

@Test func callerMergeDecisionFollowsTheNumberOrder() {
  let values: [Int64] = [.min, .min + 1, -1, 0, 1, 81_300_000_000, .max - 1, .max]
  for extra in values {
    for national in values {
      let expected: CallerMerge =
        extra < national ? .extraFirst : extra == national ? .extraReplaces : .national
      #expect(CallerMerge.decide(extra: extra, national: national) == expected)
    }
  }
}

@Test(arguments: 0..<200)
func mergedCallersMatchTheLeanModelOnSeededInputs(seed: Int) throws {
  var random = SplitMix64(seed: UInt64(seed))
  var national: [(Int64, String)] = []
  var number: Int64 = 81_300_000_000
  for index in 0..<Int(random.next() % 40) {
    number += Int64(random.next() % 3) + 1
    national.append((number, "施設\(index)（図書館）"))
  }
  // Extra numbers fall before, among, on, and after the national numbers.
  let extraNumber = 81_300_000_000 + Int64(random.next() % 140)
  let digits = String(extraNumber).dropFirst(2)
  let extra = try fixture("0" + digits, "確認用\(seed)")
  let expected = model((extra.phone.number, extra.label), national)
  let actual = try merged(
    national, extra: extra, chunk: Int(random.next() % 64) + 1, batch: Int(random.next() % 5) + 1,
    key: "\(#function)-\(seed)")
  #expect(actual.map(\.0) == expected.map(\.0))
  #expect(actual.map(\.1) == expected.map(\.1))
  #expect(zip(actual, actual.dropFirst()).allSatisfy { $0.0 < $1.0 })
  #expect(actual.filter { $0.0 == extraNumber }.map(\.1) == [extra.label])
  let kept = national.filter { $0.0 != extraNumber }
  #expect(actual.filter { $0.0 != extraNumber }.map(\.1) == kept.map(\.1))
}

@Test func aSharedNumberTakesTheExtraLabelOnce() throws {
  let national: [(Int64, String)] = [
    (81_300_000_000, "公開図書館（図書館）"), (81_300_000_001, "市役所（市区町村）"),
  ]
  let extra = try fixture("03-0000-0000")
  let entries = try merged(national, extra: extra)
  #expect(entries.map(\.0) == [81_300_000_000, 81_300_000_001])
  #expect(entries.map(\.1) == ["確認用の番号", "市役所（市区町村）"])
}

@Test func theExtraEntryJoinsBeforeAfterOrWithoutTheNationalNumbers() throws {
  let national: [(Int64, String)] = [(81_300_000_005, "公開図書館（図書館）")]
  let before = try merged(national, extra: try fixture("03-0000-0001"))
  #expect(before.map(\.0) == [81_300_000_001, 81_300_000_005])
  let after = try merged(national, extra: try fixture("03-0000-0009"))
  #expect(after.map(\.0) == [81_300_000_005, 81_300_000_009])
  let empty = try merged([], extra: try fixture("03-0000-0009"))
  #expect(empty.map(\.1) == ["確認用の番号"])
  // The owner may save a test number before the first download writes a caller file.
  let unsaved = try merged(nil, extra: try fixture("090-0000-0000"))
  #expect(unsaved.map(\.0) == [819_000_000_000])
  #expect(try merged(nil, extra: nil).isEmpty)
  #expect(try merged(national, extra: nil).map(\.1) == ["公開図書館（図書館）"])
}

@Test func callerEntriesAcceptSearchSpellingsAndRefuseOthers() throws {
  for spelling in ["03-0000-0000", "０３−００００−００００", "+81 3 0000 0000", "(03) 0000-0000"] {
    #expect(try fixture(spelling).phone.rawValue == "+81300000000")
  }
  #expect(try fixture(" 090-0000-0000 ").display == "090-0000-0000")
  for spelling in ["", "0000", "3-0000-0000", "03-0000-0000 内線", "+1 202 000 0000", "00-0000-0000"]
  {
    #expect(throws: CallerEntry.Failure.telephone) { try fixture(spelling) }
  }
  #expect(try fixture("03-0000-0000", "  確認用の番号 \n").label == "確認用の番号")
  for label in ["", " \n", "確認\u{0007}", String(repeating: "あ", count: 342)] {
    #expect(throws: CallerEntry.Failure.label) { try fixture("03-0000-0000", label) }
  }
  #expect(try fixture("03-0000-0000", String(repeating: "あ", count: 341)).label.utf8.count == 1023)
}

@Test func callerEntriesRoundTripAndRecheckStoredJSON() throws {
  let entry = try fixture("03-0000-0000")
  let data = try JSONEncoder().encode(entry)
  #expect(try JSONDecoder().decode(CallerEntry.self, from: data) == entry)
  let stored = try JSONSerialization.jsonObject(with: data) as? [String: String]
  #expect(stored == ["telephone": "03-0000-0000", "label": "確認用の番号"])
  for json in [
    #"{"telephone":"0000","label":"確認用の番号"}"#, #"{"telephone":"03-0000-0000","label":""}"#,
    #"{"label":"確認用の番号"}"#,
  ] {
    #expect(throws: (any Error).self) {
      try JSONDecoder().decode(CallerEntry.self, from: Data(json.utf8))
    }
  }
}

@Test func callerEntriesMatchQueriesLikeDirectorySearch() throws {
  let entry = try fixture("03-0000-0000")
  for query in [
    "確認用", "の番号", "確認用の番号", "03-0000-0000", "0300000000", "+81 3-0000-0000", "確認 用",
    "番号\u{3000}確認",
  ] {
    #expect(entry.matches(query: query), "\(query)")
  }
  for query in ["", "図書館", "03-0000-0001", "03-0000", "確認 図書館", "確 認 用 の 番 号 確 認 用"] {
    #expect(!entry.matches(query: query), "\(query)")
  }
  #expect(try fixture("03-0000-0000", "ＱＡ用").matches(query: "qa"))
}
