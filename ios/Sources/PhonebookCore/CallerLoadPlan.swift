public enum CallerLoadPlan: String, CaseIterable, Sendable {
  case incremental, full

  public static func decide(removals: Int, additions: Int, limit: Int) -> Self {
    guard removals >= 0, additions >= 0, limit >= 0, removals <= limit else { return .full }
    return additions <= limit - removals ? .incremental : .full
  }
}
