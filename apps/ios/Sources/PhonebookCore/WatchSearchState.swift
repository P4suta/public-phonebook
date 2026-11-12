import Foundation

public struct WatchSearchState: Sendable {
  private enum Delivery: Sendable {
    case waiting(WatchSearchRequest)
    case sent(WatchSearchRequest)
  }

  private var delivery: Delivery?
  public var pending: WatchSearchRequest? {
    guard let delivery else { return nil }
    switch delivery {
    case .waiting(let request), .sent(let request): return request
    }
  }
  public private(set) var reply: WatchSearchReply?
  public private(set) var answeredQuery = ""

  public init() {}

  public mutating func begin(_ request: WatchSearchRequest) {
    delivery = .waiting(request)
  }

  public mutating func takeRequestToSend(whenReady ready: Bool) -> WatchSearchRequest? {
    guard ready, case .some(.waiting(let request)) = delivery else { return nil }
    delivery = .sent(request)
    return request
  }

  public mutating func cancel() {
    delivery = nil
  }

  public mutating func accept(_ reply: WatchSearchReply) -> Bool {
    guard let request = pending, request.id == reply.requestID else { return false }
    delivery = nil
    if reply.state == .ready {
      self.reply = reply
      answeredQuery = request.query
    }
    return true
  }

  public mutating func fail(_ id: UUID) -> Bool {
    guard pending?.id == id else { return false }
    delivery = nil
    return true
  }
}
