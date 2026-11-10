import Foundation
import Testing

@testable import PhonebookCore

private struct PublicationContract: Decodable {
  struct State: Decodable {
    let canDiscard: Bool
    let transitions: [String: String]
  }
  let events: [String]
  let states: [String: State]
}

@Test func everyProductionPublicationTransitionRefinesTheProofContract() throws {
  let url = try #require(
    Bundle.module.url(forResource: "PublicationContract", withExtension: "json"))
  let contract = try JSONDecoder().decode(PublicationContract.self, from: Data(contentsOf: url))
  #expect(Set(contract.events) == Set(PublicationEvent.allCases.map(\.rawValue)))
  #expect(Set(contract.states.keys) == Set(PublicationPhase.allCases.map(\.rawValue)))
  var checked = 0
  for phase in PublicationPhase.allCases {
    let state = try #require(contract.states[phase.rawValue])
    #expect(Set(state.transitions.keys) == Set(contract.events))
    #expect(phase.canDiscard == state.canDiscard)
    for event in PublicationEvent.allCases {
      #expect(phase.applying(event).rawValue == state.transitions[event.rawValue])
      checked += 1
    }
  }
  #expect(checked == 25)
  #expect(PublicationPhase.active.applying(.abort) != .discarded)
}

@Test func receiveBudgetGuardsSignedBoundsWithoutOverflow() {
  for used in -3...20 {
    for incoming in -3...20 {
      for limit in -3...20 {
        let independent = used >= 0 && incoming >= 0 && used + incoming <= limit
        #expect(ReceiveBudget.admits(used: used, incoming: incoming, limit: limit) == independent)
      }
    }
  }
  #expect(ReceiveBudget.admits(used: Int.max, incoming: 0, limit: Int.max))
  #expect(!ReceiveBudget.admits(used: Int.max, incoming: 1, limit: Int.max))
  #expect(!ReceiveBudget.admits(used: Int.min, incoming: Int.max, limit: Int.max))
  #expect(!ReceiveBudget.admits(used: 0, incoming: Int.min, limit: Int.max))
  #expect(ReceiveBudget.admits(used: 0, incoming: Int.max, limit: Int.max))
}
