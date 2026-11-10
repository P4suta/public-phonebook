import Testing

@testable import PhonebookCore

@Test func nameRanksOrderStrictly() {
  #expect(NameRank.exact < .prefix && NameRank.prefix < .substring)
  #expect(!(NameRank.exact < .exact) && !(NameRank.substring < .substring))
}

@Test func telephoneSpellingsMeetTheirBoundaries() {
  let separators = String(repeating: "-", count: SearchInput.maximumPhoneLength - 10)
  #expect(SearchInput.normalizedPhone("03" + separators + "00000000") == "+81300000000")
  #expect(SearchInput.normalizedPhone("03" + separators + "-00000000") == nil)
  // Mathematical digits fold to ASCII digits, but nobody spells a telephone number with them.
  #expect(SearchInput.normalizedPhone("𝟎𝟑𝟎𝟎𝟎𝟎𝟎𝟎𝟎𝟎") == nil)
  #expect(SearchInput.nationalDisplay("+81", e164: "+81300000000") == "0300000000")
}

@Test func callerLabelsReachTheCallerFileLimit() throws {
  let label = String(repeating: "a", count: CallerFile.maximumLabelBytes)
  #expect(try CallerEntry(telephone: "03-0000-0001", label: label).label == label)
  #expect(throws: CallerEntry.Failure.label) {
    try CallerEntry(telephone: "03-0000-0001", label: label + "a")
  }
}
