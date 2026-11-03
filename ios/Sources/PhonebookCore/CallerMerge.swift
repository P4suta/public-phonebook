public enum CallerMerge: String, CaseIterable, Sendable {
  case national, extraFirst, extraReplaces

  public static func decide(extra: Int64, national: Int64) -> Self {
    if extra < national { return .extraFirst }
    if extra == national { return .extraReplaces }
    return .national
  }
}
