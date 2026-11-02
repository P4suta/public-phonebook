import Lean.Elab.Tactic.Omega

namespace Phonebook

inductive DeltaAdmission where
  | apply
  | baseMismatch
  | malformed
  | countMismatch
  | lengthMismatch
  | digestMismatch
deriving DecidableEq

def decideDelta (baseMatches wellFormed : Bool) (rows expectedRows bytes expectedBytes : Int)
    (digestMatches : Bool) : DeltaAdmission :=
  if !baseMatches then .baseMismatch
  else if !wellFormed then .malformed
  else if rows ≠ expectedRows then .countMismatch
  else if bytes ≠ expectedBytes then .lengthMismatch
  else if !digestMatches then .digestMismatch
  else .apply

def admitsCopy (start count baseRows : Int) : Prop :=
  start ≥ 0 ∧ count ≥ 1 ∧ count ≤ baseRows ∧ start ≤ baseRows - count

theorem deltaAppliesOnlyWhenEveryCheckPasses (baseMatches wellFormed digestMatches : Bool)
    (rows expectedRows bytes expectedBytes : Int) :
    decideDelta baseMatches wellFormed rows expectedRows bytes expectedBytes digestMatches = .apply ↔
      baseMatches = true ∧ wellFormed = true ∧ rows = expectedRows ∧ bytes = expectedBytes ∧
        digestMatches = true := by
  unfold decideDelta
  cases baseMatches <;> cases wellFormed <;> cases digestMatches <;>
    by_cases hRows : rows = expectedRows <;> by_cases hBytes : bytes = expectedBytes <;>
    simp_all

theorem mismatchedBaseRejectsFirst (wellFormed digestMatches : Bool)
    (rows expectedRows bytes expectedBytes : Int) :
    decideDelta false wellFormed rows expectedRows bytes expectedBytes digestMatches =
      .baseMismatch := by
  simp [decideDelta]

theorem malformedDeltaRejectsBeforeCounts (digestMatches : Bool)
    (rows expectedRows bytes expectedBytes : Int) :
    decideDelta true false rows expectedRows bytes expectedBytes digestMatches = .malformed := by
  simp [decideDelta]

theorem rowCountPrecedesLengthAndDigest (digestMatches : Bool)
    (rows expectedRows bytes expectedBytes : Int) (h : rows ≠ expectedRows) :
    decideDelta true true rows expectedRows bytes expectedBytes digestMatches =
      .countMismatch := by
  simp [decideDelta, h]

theorem lengthPrecedesDigest (digestMatches : Bool) (rows bytes expectedBytes : Int)
    (h : bytes ≠ expectedBytes) :
    decideDelta true true rows rows bytes expectedBytes digestMatches = .lengthMismatch := by
  simp [decideDelta, h]

theorem digestDecidesMatchingCounts (rows bytes : Int) :
    decideDelta true true rows rows bytes bytes false = .digestMismatch := by
  simp [decideDelta]

theorem copyAdmissionMatchesTheProviderGuard (start count baseRows : Int) :
    admitsCopy start count baseRows ↔ start ≥ 0 ∧ count ≥ 1 ∧ start + count ≤ baseRows := by
  unfold admitsCopy
  constructor
  · intro h
    rcases h with ⟨_, _, _, _⟩
    omega
  · intro h
    rcases h with ⟨_, _, _⟩
    omega

theorem admittedCopyReadsOnlyBaseRows (start count baseRows position : Int)
    (h : admitsCopy start count baseRows) (hStart : start ≤ position)
    (hEnd : position < start + count) : 0 ≤ position ∧ position < baseRows := by
  rcases h with ⟨_, _, _, _⟩
  omega

theorem copyGuardSubtractionCannotOverflowInt64 (count baseRows : Int) (hCount : count ≥ 1)
    (hRows : count ≤ baseRows) (hMax : baseRows ≤ 9223372036854775807) :
    0 ≤ baseRows - count ∧ baseRows - count ≤ 9223372036854775807 := by
  omega

theorem admittedCopyEndCannotOverflowInt64 (start count baseRows : Int)
    (h : admitsCopy start count baseRows) (hMax : baseRows ≤ 9223372036854775807) :
    -9223372036854775808 ≤ start + count ∧ start + count ≤ 9223372036854775807 := by
  rcases h with ⟨_, _, _, _⟩
  omega

#print axioms deltaAppliesOnlyWhenEveryCheckPasses
#print axioms mismatchedBaseRejectsFirst
#print axioms malformedDeltaRejectsBeforeCounts
#print axioms rowCountPrecedesLengthAndDigest
#print axioms lengthPrecedesDigest
#print axioms digestDecidesMatchingCounts
#print axioms copyAdmissionMatchesTheProviderGuard
#print axioms admittedCopyReadsOnlyBaseRows
#print axioms copyGuardSubtractionCannotOverflowInt64
#print axioms admittedCopyEndCannotOverflowInt64

end Phonebook
