import Lean.Elab.Tactic.Omega

namespace Phonebook

def pageEnd (shown total : Int) : Int :=
  if 0 ≤ shown ∧ shown ≤ total then shown + min 20 (total - shown) else 0

theorem resultPageBounds (shown total : Int) (h0 : 0 ≤ shown) (h1 : shown ≤ total) :
    shown ≤ pageEnd shown total ∧ pageEnd shown total ≤ total ∧ pageEnd shown total - shown ≤ 20 := by
  unfold pageEnd
  split <;> omega

theorem resultPageAdvances (shown total : Int) (h0 : 0 ≤ shown) (h1 : shown < total) :
    shown < pageEnd shown total := by
  unfold pageEnd
  split <;> omega

theorem resultPageArithmeticFitsInt64 (shown total : Int) (h0 : 0 ≤ shown)
    (h1 : shown ≤ total) (h2 : total ≤ 9223372036854775807) :
    0 ≤ total - shown ∧ total - shown ≤ 9223372036854775807 ∧
      pageEnd shown total ≤ 9223372036854775807 := by
  have := resultPageBounds shown total h0 h1
  omega

#print axioms resultPageBounds
#print axioms resultPageAdvances
#print axioms resultPageArithmeticFitsInt64

end Phonebook
