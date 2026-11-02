import Testing

@testable import PhonebookCore

private let expectedRows = 1
private let expectedBytes = 1

@Test func deltaAdmissionRefinesTheProviderOrderingAndCopyGuard() {
  var checked = 0
  for baseMatches in [false, true] {
    for wellFormed in [false, true] {
      for rows in 0...2 {
        for bytes in 0...2 {
          for digestMatches in [false, true] {
            let independent: DeltaAdmission
            if !baseMatches {
              independent = .baseMismatch
            } else if !wellFormed {
              independent = .malformed
            } else if rows != expectedRows {
              independent = .countMismatch
            } else if bytes != expectedBytes {
              independent = .lengthMismatch
            } else {
              independent = digestMatches ? .apply : .digestMismatch
            }
            #expect(
              DeltaAdmission.decide(
                baseMatches: baseMatches, wellFormed: wellFormed, rows: rows,
                expectedRows: expectedRows, bytes: bytes, expectedBytes: expectedBytes,
                digestMatches: digestMatches) == independent)
            checked += 1
          }
        }
      }
    }
  }
  for start in -3...20 {
    for count in -3...20 {
      for baseRows in -3...20 {
        let independent = start >= 0 && count >= 1 && start + count <= baseRows
        #expect(
          DeltaAdmission.admitsCopy(start: start, count: count, baseRows: baseRows) == independent)
        checked += 1
      }
    }
  }
  #expect(checked == 13_896)
  #expect(DeltaAdmission.admitsCopy(start: 0, count: Int.max, baseRows: Int.max))
  #expect(DeltaAdmission.admitsCopy(start: Int.max - 1, count: 1, baseRows: Int.max))
  #expect(!DeltaAdmission.admitsCopy(start: Int.max, count: 1, baseRows: Int.max))
  #expect(!DeltaAdmission.admitsCopy(start: 1, count: Int.max, baseRows: Int.max))
  #expect(!DeltaAdmission.admitsCopy(start: Int.min, count: Int.max, baseRows: Int.max))
  #expect(!DeltaAdmission.admitsCopy(start: 0, count: 1, baseRows: Int.min))
}
