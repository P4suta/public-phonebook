import PublicationModel

namespace Phonebook

def applyTrace : Phase → List Event → Phase
  | phase, [] => phase
  | phase, event :: rest => applyTrace (step phase event) rest

theorem activeAbsorbsEveryEvent (event : Event) : step .active event = .active := by
  cases event <;> rfl

theorem activeSurvivesEveryFiniteTrace (events : List Event) :
    applyTrace .active events = .active := by
  induction events with
  | nil => rfl
  | cons event rest ih => simpa [applyTrace, activeAbsorbsEveryEvent] using ih

theorem uncertainAbortRetainsData :
    step .uncertain .abort = .uncertain ∧ mayDiscard (step .uncertain .abort) = false := by
  constructor <;> rfl

theorem activeNeverPermitsDiscard : mayDiscard .active = false := by rfl

theorem beginningActivationProtectsData :
    step (step .staging .prepare) .beginActivation = .uncertain ∧
    mayDiscard (step (step .staging .prepare) .beginActivation) = false := by
  constructor <;> rfl

theorem confirmedActivationBecomesActive : step .uncertain .confirmActive = .active := by rfl

theorem confirmedInactiveCanAbort :
    step (step .uncertain .confirmInactive) .abort = .discarded := by rfl

theorem abortDiscardsOnlyKnownInactive (phase : Phase)
    (h : mayDiscard (step phase .abort) = true) :
    phase = .staging ∨ phase = .prepared ∨ phase = .discarded := by
  cases phase <;> simp_all [step, mayDiscard]

#print axioms activeAbsorbsEveryEvent
#print axioms activeSurvivesEveryFiniteTrace
#print axioms uncertainAbortRetainsData
#print axioms activeNeverPermitsDiscard
#print axioms beginningActivationProtectsData
#print axioms confirmedActivationBecomesActive
#print axioms confirmedInactiveCanAbort
#print axioms abortDiscardsOnlyKnownInactive

end Phonebook
