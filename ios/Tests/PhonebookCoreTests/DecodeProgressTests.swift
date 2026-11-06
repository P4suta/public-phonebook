import Testing

@testable import PhonebookCore

@Test func decoderProgressMatchesTheReadLoopContractAtSignedBoundaries() {
  let cases: [(Int, Int, Bool, Bool, DecodeProgress)] = [
    (0, 0, false, false, .corrupt),
    (0, 0, false, true, .truncated),
    (0, 0, true, false, .finished),
    (0, 0, true, true, .finished),
    (1, 0, false, false, .more),
    (1, 0, false, true, .more),
    (0, 1, false, false, .more),
    (0, 1, false, true, .more),
    (Int.max, 0, false, true, .more),
    (0, Int.max, false, false, .more),
    (Int.max, Int.max, false, true, .more),
    (1, 0, true, false, .finished),
    (0, 1, true, true, .finished),
    (Int.max, Int.max, true, true, .finished),
    (Int.min, 0, false, false, .corrupt),
    (0, Int.min, false, true, .truncated),
  ]
  for (consumed, produced, ended, exhausted, expected) in cases {
    #expect(
      DecodeProgress.decide(
        consumed: consumed, produced: produced, ended: ended, exhausted: exhausted) == expected)
  }
}
