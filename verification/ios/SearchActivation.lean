import Lean.Elab.Tactic.Omega

namespace Phonebook

def admitsSearch (required ready : Bool) : Bool := !required || ready

theorem requiredSearchIsReady (required ready : Bool) (h : admitsSearch required ready = true)
    (requiredByGeneration : required = true) : ready = true := by
  cases required <;> cases ready <;> simp_all [admitsSearch]

theorem unrequiredSearchKeepsReadableStorage (ready : Bool) : admitsSearch false ready = true := by
  cases ready <;> rfl

#print axioms requiredSearchIsReady
#print axioms unrequiredSearchKeepsReadableStorage

end Phonebook
