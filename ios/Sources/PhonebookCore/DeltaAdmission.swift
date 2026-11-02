public enum DeltaAdmission: String, CaseIterable, Sendable {
  case apply, baseMismatch, malformed, countMismatch, lengthMismatch, digestMismatch

  public static func decide(
    baseMatches: Bool, wellFormed: Bool, rows: Int, expectedRows: Int, bytes: Int,
    expectedBytes: Int, digestMatches: Bool
  ) -> Self {
    if !baseMatches { return .baseMismatch }
    if !wellFormed { return .malformed }
    if rows != expectedRows { return .countMismatch }
    if bytes != expectedBytes { return .lengthMismatch }
    if !digestMatches { return .digestMismatch }
    return .apply
  }

  public static func admitsCopy(start: Int, count: Int, baseRows: Int) -> Bool {
    start >= 0 && count >= 1 && count <= baseRows && start <= baseRows - count
  }
}
