import Testing

@testable import PhonebookCore

@Test func onlyAnOffExtensionPromptsForTheSettings() {
  #expect(CallerStatus.allCases == [.checking, .on, .onRetrying, .off, .unknown])
  #expect(CallerStatus.allCases.filter(\.promptsForSettings) == [.off])
}

@Test func theExtensionCountsAsOnWhenIOSReportsItOn() {
  #expect(CallerStatus.allCases.filter(\.isOn) == [.on, .onRetrying])
}
