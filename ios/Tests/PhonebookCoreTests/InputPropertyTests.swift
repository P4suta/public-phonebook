import Foundation
import Testing

@testable import PhonebookCore

private func checkInput<Value: Codable>(
  _ value: String, reference: NSRegularExpression, make: (String) throws -> Value,
  raw: (Value) -> String
) throws {
  let expected =
    reference.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
  let parsed = try? make(value)
  #expect((parsed != nil) == expected, "Input admission differs for \(value.debugDescription)")
  let encoded = try JSONEncoder().encode(value)
  if let parsed {
    #expect(raw(parsed) == value)
    #expect(try JSONDecoder().decode(String.self, from: JSONEncoder().encode(parsed)) == value)
    #expect(try raw(JSONDecoder().decode(Value.self, from: encoded)) == value)
  } else {
    #expect(throws: (any Error).self) { try JSONDecoder().decode(Value.self, from: encoded) }
  }
}

@Test func everyASCIIPrefecturePairMatchesTheIndependentGrammarAndCodableBoundary() throws {
  let reference = try NSRegularExpression(pattern: "\\A(?:0[1-9]|[1-3][0-9]|4[0-7])\\z")
  var checked = 0
  for first in UInt8(0)...127 {
    for second in UInt8(0)...127 {
      let value = String(UnicodeScalar(first)) + String(UnicodeScalar(second))
      try checkInput(value, reference: reference, make: PrefectureCode.init, raw: \.rawValue)
      checked += 1
    }
  }
  #expect(checked == 16_384)
  for value in ["", "1", "001", "１４", "\u{0661}\u{0664}", "1\u{200B}", "😀"] {
    try checkInput(value, reference: reference, make: PrefectureCode.init, raw: \.rawValue)
  }
}

@Test func everyPrefectureOrderingPairMatchesItsNumericMeaning() throws {
  var checked = 0
  for first in 1...47 {
    for second in 1...47 {
      let lhs = try PrefectureCode(String(format: "%02d", first))
      let rhs = try PrefectureCode(String(format: "%02d", second))
      #expect((lhs < rhs) == (first < second))
      #expect((lhs == rhs) == (first == second))
      checked += 1
    }
  }
  #expect(checked == 2_209)
}

@Test func snapshotByteSubstitutionsAndLengthsMatchTheIndependentGrammar() throws {
  let reference = try NSRegularExpression(pattern: "\\A[0-9a-f]{64}\\z")
  let baseline = Array(String(repeating: "a", count: 64))
  var checked = 0
  for position in baseline.indices {
    for byte in UInt8(0)...127 {
      var value = baseline
      value[position] = Character(String(UnicodeScalar(byte)))
      try checkInput(String(value), reference: reference, make: SnapshotID.init, raw: \.rawValue)
      checked += 1
    }
  }
  #expect(checked == 8_192)
  for count in 0...128 {
    try checkInput(
      String(repeating: "a", count: count), reference: reference, make: SnapshotID.init,
      raw: \.rawValue)
  }
  for suffix in ["Ａ", "é", "e\u{0301}", "\u{200B}", "😀"] {
    try checkInput(
      String(repeating: "a", count: 63) + suffix, reference: reference, make: SnapshotID.init,
      raw: \.rawValue)
  }
}

@Test func canonicalPhoneMutationsMatchTheIndependentGrammarAndNumericIdentity() throws {
  let reference = try NSRegularExpression(pattern: "\\A\\+81[1-9][0-9]{8,9}\\z")
  var checked = 0
  for seed in ["+81353211111", "+819012345678"] {
    let baseline = Array(seed)
    for position in baseline.indices {
      for byte in UInt8(0)...127 {
        var characters = baseline
        characters[position] = Character(String(UnicodeScalar(byte)))
        let value = String(characters)
        try checkInput(value, reference: reference, make: CanonicalPhone.init, raw: \.rawValue)
        if let phone = try? CanonicalPhone(value) {
          #expect(String(phone.number) == String(value.dropFirst()))
        }
        checked += 1
      }
    }
  }
  #expect(checked == 3_200)
  for count in 0...20 {
    try checkInput(
      "+81" + String(repeating: "1", count: count), reference: reference, make: CanonicalPhone.init,
      raw: \.rawValue)
  }
  for value in [
    "+81１２３４５６７８９", "+81\u{0661}\u{0662}\u{0663}\u{0664}\u{0665}\u{0666}\u{0667}\u{0668}\u{0669}",
    "+81353211111\n", " +81353211111",
  ] {
    try checkInput(value, reference: reference, make: CanonicalPhone.init, raw: \.rawValue)
  }
}
