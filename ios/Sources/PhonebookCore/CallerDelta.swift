public enum CallerChange: String, CaseIterable, Sendable {
  case remove, add, keep, replace

  public static func decide(held: Int64, heldLabel: String, wanted: Int64, wantedLabel: String)
    -> Self
  {
    if held < wanted { return .remove }
    if wanted < held { return .add }
    if heldLabel.utf8.elementsEqual(wantedLabel.utf8) { return .keep }
    return .replace
  }
}
