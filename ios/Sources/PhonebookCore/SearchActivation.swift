public enum SearchActivation {
  public static func permits(required: Bool, ready: Bool) -> Bool {
    !required || ready
  }
}
