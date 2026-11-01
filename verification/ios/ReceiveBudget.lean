import Lean.Elab.Tactic.Omega

namespace Phonebook

def admits (used incoming limit : Int) : Prop :=
  used ≥ 0 ∧ incoming ≥ 0 ∧ limit ≥ used ∧ incoming ≤ limit - used

theorem admittedBytesStayWithinLimit (used incoming limit : Int)
    (h : admits used incoming limit) : 0 ≤ used + incoming ∧ used + incoming ≤ limit := by
  rcases h with ⟨_, _, _, _⟩
  omega

theorem admittedAdditionCannotOverflowInt64 (used incoming limit : Int)
    (h : admits used incoming limit) (hLimit : limit ≤ 9223372036854775807) :
    -9223372036854775808 ≤ used + incoming ∧ used + incoming ≤ 9223372036854775807 := by
  have := admittedBytesStayWithinLimit used incoming limit h
  omega

theorem subtractionCannotOverflowInt64 (used limit : Int)
    (hUsed : used ≥ 0) (hLimit : limit ≥ used) (hMax : limit ≤ 9223372036854775807) :
    0 ≤ limit - used ∧ limit - used ≤ 9223372036854775807 := by omega

#print axioms admittedBytesStayWithinLimit
#print axioms admittedAdditionCannotOverflowInt64
#print axioms subtractionCannotOverflowInt64

end Phonebook
