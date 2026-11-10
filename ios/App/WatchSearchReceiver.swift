import Foundation
import PhonebookCore
import PhonebookKit
import Synchronization
import WatchConnectivity

final class WatchSearchReceiver: NSObject, WCSessionDelegate, Sendable {
  private let search: WatchDirectorySearch
  private let pending = Mutex<Task<Void, Never>?>(nil)

  init(store: SnapshotStore) {
    search = WatchDirectorySearch(store: store)
    super.init()
    guard WCSession.isSupported() else { return }
    WCSession.default.delegate = self
    WCSession.default.activate()
  }

  func session(
    _ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
    error: (any Error)?
  ) {}

  func sessionDidBecomeInactive(_ session: WCSession) {
    pending.withLock { $0?.cancel() }
  }

  func sessionDidDeactivate(_ session: WCSession) {
    session.activate()
  }

  func session(
    _ session: WCSession, didReceiveMessageData messageData: Data,
    replyHandler: @escaping (Data) -> Void
  ) {
    guard let request = try? WatchSearchRequest.decode(messageData) else {
      replyHandler(Data())
      return
    }
    let delivery = WatchReplyDelivery(replyHandler)
    pending.withLock { task in
      task?.cancel()
      task = Task { [search] in
        do {
          let reply = try await search.search(request)
          try Task.checkCancellation()
          delivery.send(try reply.encoded())
        } catch {
          let reply = try? WatchSearchReply(
            requestID: request.id, state: .unavailable, results: [], total: 0)
          delivery.send((try? reply?.encoded()) ?? Data())
        }
      }
    }
  }
}

// Watch Connectivity supplies an escaping Objective-C reply block without a Sendable annotation.
// The block is immutable, and the mutex permits one invocation.
// https://developer.apple.com/documentation/watchconnectivity/wcsessiondelegate/session(_:didreceivemessagedata:replyhandler:)
private final class WatchReplyDelivery: @unchecked Sendable {
  private let callback: (Data) -> Void
  private let delivered = Mutex(false)

  init(_ callback: @escaping (Data) -> Void) {
    self.callback = callback
  }

  func send(_ data: Data) {
    let accepted = delivered.withLock { delivered in
      guard !delivered else { return false }
      delivered = true
      return true
    }
    if accepted { callback(data) }
  }
}
