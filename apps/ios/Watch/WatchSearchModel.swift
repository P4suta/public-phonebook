import Foundation
import Observation
import PhonebookCore
import WatchConnectivity

@Observable @MainActor
final class WatchSearchModel: NSObject, WCSessionDelegate {
  var query = "" {
    didSet {
      if query != oldValue {
        state.cancel()
        timeout?.cancel()
        message = nil
      }
    }
  }
  var loading: Bool { state.pending != nil }
  private(set) var message: String?
  var reply: WatchSearchReply? { state.reply }
  var answeredQuery: String { state.answeredQuery }
  private var state = WatchSearchState()
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
      message =
        SearchInput.words(query).isEmpty
        ? "施設の名前を入れてください。" : "検索する言葉を短くしてください。"
      return
    }
    let session = WCSession.default
    guard session.activationState == .activated, session.isReachable else {
      message = "iPhoneでPublic Phonebookを開いてください。"
      return
    }
    state.begin(request)
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
    guard state.pending?.id == request.id else { return }
    guard let reply = try? WatchSearchReply.decode(data), state.accept(reply) else {
      failed(request.id)
      return
    }
    timeout?.cancel()
    switch reply.state {
    case .ready:
      message = nil
    case .needsPreparation:
      message = "iPhoneでPublic Phonebookを開き、検索の準備を終えてください。"
    case .unavailable:
      message = "さがせませんでした。iPhoneでPublic Phonebookを開いて、もう一度さがしてください。"
    }
  }

  private func failed(_ id: UUID) {
    guard state.fail(id) else { return }
    timeout?.cancel()
    message = "iPhoneにつながりませんでした。iPhoneでPublic Phonebookを開いてください。"
  }

  nonisolated func session(
    _ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
    error: (any Error)?
  ) {}
}
