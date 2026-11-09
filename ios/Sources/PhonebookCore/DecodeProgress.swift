public enum DecodeProgress: Equatable, CaseIterable, Sendable {
  case more, finished, corrupt, truncated

  public static func decide(consumed: Int, produced: Int, ended: Bool, exhausted: Bool) -> Self {
    if ended { return .finished }
    if consumed > 0 || produced > 0 { return .more }
    return exhausted ? .truncated : .corrupt
  }
}
