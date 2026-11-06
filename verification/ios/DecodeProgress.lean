import Lean.Elab.Tactic.Omega

namespace Phonebook

inductive DecodeStep where
  | more | finished | corrupt | truncated
  deriving DecidableEq, Repr

def decodeProgress (consumed produced : Int) (ended exhausted : Bool) : DecodeStep :=
  if ended then .finished
  else if 0 < consumed ∨ 0 < produced then .more
  else if exhausted then .truncated else .corrupt

theorem finishedDecodeOnlyAfterEnd (consumed produced : Int) (ended exhausted : Bool) :
    decodeProgress consumed produced ended exhausted = .finished ↔ ended = true := by
  unfold decodeProgress
  split
  · simp_all
  · split
    · simp_all
    · split <;> simp_all

theorem unfinishedDecodeMakesProgress (consumed produced : Int) (ended exhausted : Bool) :
    decodeProgress consumed produced ended exhausted = .more ↔
      ended = false ∧ (0 < consumed ∨ 0 < produced) := by
  unfold decodeProgress
  split
  · simp_all
  · split
    · simp_all
    · split <;> simp_all

theorem stalledDecodeAtEOFIsTruncated (consumed produced : Int)
    (hc : consumed ≤ 0) (hp : produced ≤ 0) :
    decodeProgress consumed produced false true = .truncated := by
  simp [decodeProgress] <;> omega

theorem stalledDecodeBeforeEOFIsCorrupt (consumed produced : Int)
    (hc : consumed ≤ 0) (hp : produced ≤ 0) :
    decodeProgress consumed produced false false = .corrupt := by
  simp [decodeProgress] <;> omega

#print axioms finishedDecodeOnlyAfterEnd
#print axioms unfinishedDecodeMakesProgress
#print axioms stalledDecodeAtEOFIsTruncated
#print axioms stalledDecodeBeforeEOFIsCorrupt

end Phonebook
