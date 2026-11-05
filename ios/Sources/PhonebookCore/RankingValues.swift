public struct RankingValues<Element: Sendable>: RandomAccessCollection, Sendable {
  public typealias Index = Int
  public let startIndex = 0
  public let endIndex: Int
  private let read: @Sendable (Int) -> Element

  public init(_ values: [Element]) {
    endIndex = values.count
    read = { values[$0] }
  }

  public init(count: Int, read: @escaping @Sendable (Int) -> Element) {
    precondition(count >= 0)
    endIndex = count
    self.read = read
  }

  public subscript(position: Int) -> Element { read(position) }

  public func project<Value: Sendable>(
    _ transform: @escaping @Sendable (Element) -> Value
  ) -> RankingValues<Value> {
    RankingValues<Value>(count: count) { transform(self[$0]) }
  }
}
