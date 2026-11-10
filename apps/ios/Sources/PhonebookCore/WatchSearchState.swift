import Foundation

public struct WatchSearchState: Sendable {
  public private(set) var pending: WatchSearchRequest?
  public private(set) var reply: WatchSearchReply?
  public private(set) var answeredQuery = ""

  public init() {}

  public mutating func begin(_ request: WatchSearchRequest) {
    pending = request
  }

  public mutating func cancel() {
    pending = nil
  }

  public mutating func accept(_ reply: WatchSearchReply) -> Bool {
    guard let request = pending, request.id == reply.requestID else { return false }
    pending = nil
    if reply.state == .ready {
      self.reply = reply
      answeredQuery = request.query
    }
    return true
  }

  public mutating func fail(_ id: UUID) -> Bool {
    guard pending?.id == id else { return false }
    pending = nil
    return true
  }
}
