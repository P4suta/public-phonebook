import Foundation
import Testing

@testable import PhonebookCore

private func watchReply(_ request: WatchSearchRequest, name: String) throws -> WatchSearchReply {
  let facility = try WatchFacility(
    id: 1, name: name, region: "", numbers: ["+81300000000"], publisher: "Test city",
    sourceURL: "https://example.com/directory", license: "CC0")
  return try WatchSearchReply(
    requestID: request.id, state: .ready, results: [facility], total: 1)
}

@Test func newerWatchResultsSurviveAnEarlierReplyArrivingLast() throws {
  let earlier = try WatchSearchRequest(id: UUID(), query: "earlier library")
  let newer = try WatchSearchRequest(id: UUID(), query: "newer clinic")
  let earlierReply = try watchReply(earlier, name: "Earlier library")
  let newerReply = try watchReply(newer, name: "Newer clinic")
  var state = WatchSearchState()
  state.begin(earlier)
  state.begin(newer)
  let acceptedNewer = state.accept(newerReply)
  let acceptedEarlier = state.accept(earlierReply)
  #expect(acceptedNewer)
  #expect(!acceptedEarlier)
  #expect(state.pending == nil)
  #expect(state.answeredQuery == newer.query)
  #expect(state.reply == newerReply)
}

@Test func cancelledWatchRequestsAndStaleFailuresKeepSuccessfulResults() throws {
  let successful = try WatchSearchRequest(id: UUID(), query: "library")
  let pending = try WatchSearchRequest(id: UUID(), query: "clinic")
  let successfulReply = try watchReply(successful, name: "Library")
  var state = WatchSearchState()
  state.begin(successful)
  let acceptedInitial = state.accept(successfulReply)
  #expect(acceptedInitial)
  state.begin(pending)
  let acceptedStaleReply = state.accept(successfulReply)
  let failedStaleRequest = state.fail(successful.id)
  #expect(!acceptedStaleReply)
  #expect(!failedStaleRequest)
  #expect(state.pending == pending)
  let failedCurrent = state.fail(pending.id)
  let acceptedAfterFailure = state.accept(try watchReply(pending, name: "Clinic"))
  #expect(failedCurrent)
  #expect(!acceptedAfterFailure)
  state.begin(pending)
  state.cancel()
  let acceptedAfterCancellation = state.accept(try watchReply(pending, name: "Clinic"))
  #expect(!acceptedAfterCancellation)
  #expect(state.pending == nil)
  #expect(state.reply == successfulReply)
  #expect(state.answeredQuery == successful.query)
}

@Test func unavailableWatchRepliesKeepTheLastSuccessfulQueryAndResults() throws {
  let successful = try WatchSearchRequest(id: UUID(), query: "library")
  let successfulReply = try watchReply(successful, name: "Library")
  for availability in [WatchSearchReply.State.needsPreparation, .unavailable] {
    var state = WatchSearchState()
    state.begin(successful)
    let acceptedInitial = state.accept(successfulReply)
    #expect(acceptedInitial)
    let pending = try WatchSearchRequest(id: UUID(), query: "clinic")
    state.begin(pending)
    let acceptedUnavailable = state.accept(
      try WatchSearchReply(requestID: pending.id, state: availability, results: [], total: 0))
    let failedAfterReply = state.fail(pending.id)
    #expect(acceptedUnavailable)
    #expect(!failedAfterReply)
    #expect(state.pending == nil)
    #expect(state.reply == successfulReply)
    #expect(state.answeredQuery == successful.query)
  }
}

@Test func watchRequestsWaitForReadinessAndSendOnce() throws {
  let request = try WatchSearchRequest(id: UUID(), query: "library")
  var state = WatchSearchState()
  #expect(state.takeRequestToSend(whenReady: true) == nil)
  state.begin(request)
  #expect(state.takeRequestToSend(whenReady: false) == nil)
  #expect(state.pending == request)
  #expect(state.takeRequestToSend(whenReady: true) == request)
  #expect(state.pending == request)
  #expect(state.takeRequestToSend(whenReady: true) == nil)
}

@Test func onlyTheLatestWatchRequestWaitsForTheConnection() throws {
  let earlier = try WatchSearchRequest(id: UUID(), query: "library")
  let latest = try WatchSearchRequest(id: UUID(), query: "clinic")
  var state = WatchSearchState()
  state.begin(earlier)
  state.begin(latest)
  #expect(state.takeRequestToSend(whenReady: true) == latest)
  #expect(state.takeRequestToSend(whenReady: true) == nil)
  let acceptedEarlier = state.accept(try watchReply(earlier, name: "Library"))
  #expect(!acceptedEarlier)
  state.begin(latest)
  #expect(state.takeRequestToSend(whenReady: true) == latest)
}

@Test func completedWatchRequestsCannotSendAfterAConnectionChange() throws {
  let request = try WatchSearchRequest(id: UUID(), query: "library")
  var state = WatchSearchState()
  state.begin(request)
  state.cancel()
  #expect(state.takeRequestToSend(whenReady: true) == nil)
  state.begin(request)
  let failed = state.fail(request.id)
  #expect(failed)
  #expect(state.takeRequestToSend(whenReady: true) == nil)
  state.begin(request)
  let accepted = state.accept(try watchReply(request, name: "Library"))
  #expect(accepted)
  #expect(state.takeRequestToSend(whenReady: true) == nil)
}
