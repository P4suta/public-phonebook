import Testing

@testable import PhonebookCore

@Test func onlyAnOffExtensionPromptsForTheSettings() {
  #expect(CallerStatus.allCases == [.checking, .on, .loading, .onRetrying, .off, .unknown])
  #expect(CallerStatus.allCases.filter(\.promptsForSettings) == [.off])
}

@Test func theExtensionCountsAsOnWhenIOSReportsItOn() {
  #expect(CallerStatus.allCases.filter(\.isOn) == [.on, .loading, .onRetrying])
}

/// Covers every Call Directory code in the iOS SDK's `CXError.h`, a code beyond them, and the other replies.
@Test func everyReloadReplyLeadsToItsState() {
  #expect(CallerReply.loaded.status == .on)
  #expect(CallerReply.other.status == .onRetrying)
  for code in -1...9 {
    let expected: CallerStatus =
      switch code {
      case 7: .loading
      case 6: .off
      default: .onRetrying
      }
    #expect(CallerReply.callDirectory(code: code).status == expected, "\(code)")
  }
  #expect(CallerReply.currentlyLoading == 7 && CallerReply.extensionDisabled == 6)
}
