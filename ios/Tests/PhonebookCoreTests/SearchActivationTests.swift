import Testing

@testable import PhonebookCore

@Test func searchActivationRequiresEveryMandatorySearchFile() {
  #expect(!SearchActivation.permits(required: true, ready: false))
  #expect(SearchActivation.permits(required: true, ready: true))
  #expect(SearchActivation.permits(required: false, ready: false))
  #expect(SearchActivation.permits(required: false, ready: true))
}
