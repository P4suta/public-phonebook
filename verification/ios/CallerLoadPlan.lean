import Lean.Elab.Tactic.Omega

namespace Phonebook

inductive CallerLoad where
  | incremental | full
  deriving DecidableEq, Repr

def decideCallerLoad (removals additions limit : Int) : CallerLoad :=
  if 0 ≤ removals ∧ 0 ≤ additions ∧ 0 ≤ limit ∧ removals ≤ limit then
    if additions ≤ limit - removals then .incremental else .full
  else .full

theorem incrementalCallerWorkIsBounded (removals additions limit : Int) :
    decideCallerLoad removals additions limit = .incremental ↔
      0 ≤ removals ∧ 0 ≤ additions ∧ 0 ≤ limit ∧ removals + additions ≤ limit := by
  by_cases allowed : 0 ≤ removals ∧ 0 ≤ additions ∧ 0 ≤ limit ∧ removals ≤ limit
    <;> by_cases budget : additions ≤ limit - removals
    <;> simp [decideCallerLoad, allowed, budget] <;> omega

theorem invalidCallerCountsUseFull (removals additions limit : Int)
    (h : removals < 0 ∨ additions < 0 ∨ limit < 0) :
    decideCallerLoad removals additions limit = .full := by
  have denied : ¬ (0 ≤ removals ∧ 0 ≤ additions ∧ 0 ≤ limit ∧ removals ≤ limit) := by omega
  simp [decideCallerLoad, denied]

theorem callerLoadSubtractionFitsInt64 (removals limit : Int)
    (hRemovals : 0 ≤ removals) (hLimit : removals ≤ limit)
    (hMax : limit ≤ 9223372036854775807) :
    0 ≤ limit - removals ∧ limit - removals ≤ 9223372036854775807 := by omega

theorem noCallerChangesAreIncremental (limit : Int) (h : 0 ≤ limit) :
    decideCallerLoad 0 0 limit = .incremental := by
  simp [decideCallerLoad, h]

#print axioms incrementalCallerWorkIsBounded
#print axioms invalidCallerCountsUseFull
#print axioms callerLoadSubtractionFitsInt64
#print axioms noCallerChangesAreIncremental

end Phonebook
