public enum PackedRankingPolicy {
  public static let maximumBytes = 268_435_456

  public static func scratchSum(total: UInt32, increment: UInt32) -> UInt32 {
    total + increment
  }

  public static func readingKey(row: Int, contacts: Int, frequency: UInt32) -> UInt32 {
    UInt32((6 - Int(frequency)) * contacts + row)
  }

  public static func fits(offset: Int, length: Int, size: Int) -> Bool {
    guard offset >= 0, length >= 0, size >= 0,
      offset <= maximumBytes, length <= maximumBytes, size <= maximumBytes
    else { return false }
    return offset <= size && length <= size - offset
  }

  public static func midpoint(low: Int, high: Int) -> Int {
    guard low >= 0, low < high, high <= maximumBytes else { return 0 }
    return low + (high - low) / 2
  }
}
