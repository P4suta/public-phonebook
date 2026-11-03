import Testing

@testable import PhonebookCore

@Test func identifiersRejectMalformedExternalValues() throws {
  #expect(try PrefectureCode("01").rawValue == "01")
  #expect(try PrefectureCode("47").rawValue == "47")
  for value in ["", "1", "00", "48", "１４", "14x", " 14"] {
    #expect(throws: InputError.self) { try PrefectureCode(value) }
  }
  #expect(try SnapshotID(String(repeating: "a", count: 64)).rawValue.count == 64)
  #expect(throws: InputError.self) { try SnapshotID(String(repeating: "A", count: 64)) }
  #expect(try CanonicalPhone("+81353211111").number == 8_135_321_1111)
  for value in ["0353211111", "+1-234", "+810353211111", "+81１２３４５６７８９", "+819"] {
    #expect(throws: InputError.self) { try CanonicalPhone(value) }
  }
}

@Test func everyPublicationInputPreservesThePreviousSnapshot() {
  var cases = 0
  for current in [false, true] {
    for complete in [false, true] {
      for snapshot in [false, true] {
        for records in [false, true] {
          let result = PublicationDecision.decide(
            current: current, complete: complete,
            snapshot: snapshot, records: records
          )
          #expect((result == .publish) == (current && complete && snapshot && records))
          cases += 1
        }
      }
    }
  }
  #expect(cases == 16)
}

@Test func sharedNumbersNeverPickAnArbitraryOrganization() {
  #expect(
    CallerLabel.make(names: ["City Hall", "City Hall"], category: "Office") == "City Hall（Office）")
  #expect(CallerLabel.make(names: ["School", "Library"], category: "Office") == "公共施設（2つの名称で登録）")
}

/// The single-name shortcut returns what the set-based rule returns, including canonically equal spellings.
@Test func everyNameListUpToThreeMatchesTheSetBasedLabelRule() {
  func reference(_ names: [String], _ category: String) -> String {
    let unique = Set(names).sorted()
    if unique.count == 1, let name = unique.first { return "\(name)（\(category)）" }
    return "公共施設（\(unique.count)つの名称で登録）"
  }
  let alphabet = ["", "A", "a", "が", "か\u{3099}", "ｶﾞ", "市役所", "市役所 "]
  var longest = alphabet.map { [$0] }
  var lists = longest
  for _ in 2...3 {
    longest = longest.flatMap { list in alphabet.map { list + [$0] } }
    lists += longest
  }
  var checked = 0
  for names in lists {
    for category in ["図書館", "図書館・病院"] {
      #expect(CallerLabel.make(names: names, category: category) == reference(names, category))
      checked += 1
    }
  }
  #expect(checked == 2 * (8 + 64 + 512))
}
