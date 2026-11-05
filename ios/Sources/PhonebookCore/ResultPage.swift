public enum ResultPage {
  public static let size = 20

  public static func end(shown: Int, total: Int) -> Int {
    guard shown >= 0, total >= shown else { return 0 }
    return shown + min(size, total - shown)
  }
}
