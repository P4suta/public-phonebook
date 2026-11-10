import Foundation
import Observation
import PhonebookCore
import WatchConnectivity

@Observable @MainActor
final class WatchSearchModel: NSObject, WCSessionDelegate {
  var query = "" {
    didSet {
      if query != oldValue {
        pendingID = nil
        timeout?.cancel()
        loading = false
        message = nil
      }
    }
  }
  private(set) var loading = false
  private(set) var message: String?
  private(set) var reply: WatchSearchReply?
  private(set) var answeredQuery = ""
  @ObservationIgnored private var pendingID: UUID?
  @ObservationIgnored private var timeout: Task<Void, Never>?

  override init() {
    super.init()
    WCSession.default.delegate = self
    WCSession.default.activate()
  }

  var canSearch: Bool { !loading && !SearchInput.words(query).isEmpty }

  func search() {
    guard let request = try? WatchSearchRequest(id: UUID(), query: query),
      let data = try? request.encoded()
    else {
      message = "検索する言葉を短くしてください。"
      return
    }
    let session = WCSession.default
    guard session.activationState == .activated, session.isReachable else {
      message = "iPhoneでPublic Phonebookを開いてください。"
      return
    }
    pendingID = request.id
    loading = true
    message = nil
    timeout?.cancel()
    timeout = Task { [weak self] in
      do { try await Task.sleep(for: .seconds(20)) } catch { return }
      self?.failed(request.id)
    }
    session.sendMessageData(
      data,
      replyHandler: { @Sendable [weak self] data in
        Task { @MainActor in self?.receive(data, request: request) }
      },
      errorHandler: { @Sendable [weak self] _ in
        Task { @MainActor in self?.failed(request.id) }
      })
  }

  private func receive(_ data: Data, request: WatchSearchRequest) {
    guard pendingID == request.id else { return }
    guard let reply = try? WatchSearchReply.decode(data), reply.requestID == request.id else {
      failed(request.id)
      return
    }
    timeout?.cancel()
    pendingID = nil
    loading = false
    switch reply.state {
    case .ready:
      self.reply = reply
      answeredQuery = request.query
      message = nil
    case .needsPreparation:
      message = "iPhoneでPublic Phonebookを開き、検索の準備を終えてください。"
    case .unavailable:
      message = "さがせませんでした。iPhoneで確認してください。"
    }
  }

  private func failed(_ id: UUID) {
    guard pendingID == id else { return }
    timeout?.cancel()
    pendingID = nil
    loading = false
    message = "iPhoneにつながりませんでした。iPhoneでPublic Phonebookを開いてください。"
  }

  nonisolated func session(
    _ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
    error: (any Error)?
  ) {}
}
