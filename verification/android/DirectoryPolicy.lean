import Lean.Elab.Tactic.Omega

namespace Phonebook.Android

def behavioralKill (compiled completed failed aborted : Bool) : Bool :=
  compiled && completed && failed && !aborted

theorem killedMutantsRequireCompletedBehavior (compiled completed failed aborted : Bool) :
    behavioralKill compiled completed failed aborted = true ↔
    compiled = true ∧ completed = true ∧ failed = true ∧ aborted = false := by
  simp [behavioralKill, Bool.and_eq_true, and_assoc]

def completeCampaign (expected executed : Nat) (allKilled : Bool) : Bool :=
  decide (expected > 0 ∧ expected = executed) && allKilled

theorem mutationCampaignRequiresEveryExpectedResult (expected executed : Nat) (allKilled : Bool) :
    completeCampaign expected executed allKilled = true ↔
    expected > 0 ∧ expected = executed ∧ allKilled = true := by
  simp [completeCampaign, Bool.and_eq_true, and_assoc]

def validJsonDepth (depth : Int) : Bool := decide (0 ≤ depth ∧ depth < 32)

theorem acceptedJsonDepthIsBounded (depth : Int) (h : validJsonDepth depth = true) :
    0 ≤ depth ∧ depth < 32 := by simpa [validJsonDepth] using h

theorem jsonDescentFitsInt32 (depth : Int) (h : validJsonDepth depth = true) :
    0 ≤ depth + 1 ∧ depth + 1 ≤ 32 ∧ depth + 1 ≤ 2147483647 := by
  simp [validJsonDepth] at h
  omega

def restartPage {α : Type} [DecidableEq α] (more : Bool) (previous received : Option α) : Bool :=
  more && decide (previous ≠ received)

def canAppendPage (more sameQuery : Bool) : Bool := more && sameQuery

theorem pageAppendRequiresTheSameQuery (more sameQuery : Bool) :
    canAppendPage more sameQuery = true ↔ more = true ∧ sameQuery = true := by
  simp [canAppendPage, Bool.and_eq_true]

theorem pageRestartRequiresGenerationChange {α : Type} [DecidableEq α]
    (more : Bool) (previous received : Option α) :
    restartPage more previous received = true ↔ more = true ∧ previous ≠ received := by
  simp [restartPage, Bool.and_eq_true]

def admit (length digest snapshot rows complete : Bool) : Bool :=
  length && digest && snapshot && rows && complete

theorem admissionRequiresEveryCheck (length digest snapshot rows complete : Bool) :
    admit length digest snapshot rows complete = true ↔
    length = true ∧ digest = true ∧ snapshot = true ∧ rows = true ∧ complete = true := by
  simp [admit, Bool.and_eq_true, and_assoc]

def transfer (metered restricted : Bool) : Bool := !metered && !restricted

theorem automaticTransfersAvoidRestrictedPaths (metered restricted : Bool) :
    transfer metered restricted = true ↔ metered = false ∧ restricted = false := by
  simp [transfer, Bool.and_eq_true]

def due (last : Option Int) (now : Int) : Bool :=
  match last with
  | none => true
  | some last => decide (last ≥ 0 ∧ now ≥ last ∧ now - last ≥ 86400)

theorem answeredChecksWaitADay (last now : Int) (h : due (some last) now = true) :
    last + 86400 ≤ now := by
  simp [due] at h
  omega

theorem dueSubtractionFitsInt64 (last now : Int)
    (hLast : last ≥ 0) (hOrder : now ≥ last) (hNow : now ≤ 9223372036854775807) :
    0 ≤ now - last ∧ now - last ≤ 9223372036854775807 := by omega

def chunk (received count expected : Int) : Bool :=
  decide (received ≥ 0 ∧ count ≥ 0 ∧ received ≤ expected ∧ count ≤ expected - received)

theorem acceptedChunksStayWithinTheFile (received count expected : Int)
    (h : chunk received count expected = true) :
    0 ≤ received + count ∧ received + count ≤ expected := by
  simp [chunk] at h
  omega

theorem acceptedChunkArithmeticFitsInt64 (received count expected : Int)
    (h : chunk received count expected = true) (hExpected : expected ≤ 9223372036854775807) :
    received + count ≤ 9223372036854775807 ∧
    -9223372036854775808 ≤ expected - received := by
  simp [chunk] at h
  omega

def copy (start count base : Int) : Bool :=
  decide (start ≥ 0 ∧ count ≥ 1 ∧ count ≤ base ∧ start ≤ base - count)

theorem acceptedCopiesReadOnlyBaseRows (start count base index : Int)
    (h : copy start count base = true) (hIndex : start ≤ index ∧ index < start + count) :
    0 ≤ index ∧ index < base := by
  simp [copy] at h
  omega

theorem copyArithmeticFitsInt64 (start count base : Int)
    (h : copy start count base = true) (hBase : base ≤ 9223372036854775807) :
    0 ≤ base - count ∧ base - count ≤ 9223372036854775807 ∧
    0 ≤ start + count ∧ start + count ≤ 9223372036854775807 := by
  simp [copy] at h
  omega

def wordRank (words named placed rank : Nat) : Option Nat :=
  if named + placed < words then none
  else if named < words then some 3
  else if words = 1 then some rank else some 2

theorem unmatchedWordsReject (words named placed rank : Nat) (h : named + placed < words) :
    wordRank words named placed rank = none := by simp [wordRank, h]

theorem regionMatchesRankAfterNameMatches (words named placed rank : Nat)
    (hAll : words ≤ named + placed) (hPlace : named < words) :
    wordRank words named placed rank = some 3 := by simp [wordRank]; omega

inductive Phase where | receiving | indexed | uncertain | complete deriving DecidableEq

def canActivate (phase : Phase) (valid : Bool) : Bool := decide (phase = .indexed) && valid

theorem activationRequiresIndexedAndValidatedCandidate (phase : Phase) (valid : Bool) :
    canActivate phase valid = true ↔ phase = .indexed ∧ valid = true := by
  simp [canActivate, Bool.and_eq_true]

def canDiscard (phase : Phase) : Bool := decide (phase ≠ .uncertain ∧ phase ≠ .complete)

theorem uncertainCandidateSurvivesAbort : canDiscard .uncertain = false := by simp [canDiscard]
theorem activeCandidateSurvivesAbort : canDiscard .complete = false := by simp [canDiscard]

def select {α : Type} (active : Option α) (candidate : α) (phase : Phase)
    (valid observed : Bool) : Option α :=
  if valid = false then active
  else if phase = .complete then some candidate
  else if phase = .uncertain ∧ observed = true then some candidate else active

theorem prepublicationImportRetainsTheActiveGeneration {α : Type} (active : Option α)
    (candidate : α) (phase : Phase) (valid observed : Bool)
    (h : phase ≠ .complete ∧ phase ≠ .uncertain) :
    select active candidate phase valid observed = active := by simp [select, h.1, h.2]

theorem rejectedImportRetainsTheActiveGeneration {α : Type} (active : Option α)
    (candidate : α) (phase : Phase) (observed : Bool) :
    select active candidate phase false observed = active := by simp [select]

theorem completeImportActivatesAsAUnit {α : Type} (active : Option α) (candidate : α) (observed : Bool) :
    select active candidate .complete true observed = some candidate := by simp [select]

theorem unconfirmedPublicationRetainsTheActiveGeneration {α : Type}
    (active : Option α) (candidate : α) (valid : Bool) :
    select active candidate .uncertain valid false = active := by simp [select]

theorem confirmedUncertainPublicationActivates {α : Type} (active : Option α) (candidate : α) :
    select active candidate .uncertain true true = some candidate := by simp [select]

def selections {α : Type} : Option α → List (α × Phase × Bool × Bool) → Option α
  | active, [] => active
  | active, (candidate, phase, valid, observed) :: rest =>
    selections (select active candidate phase valid observed) rest

theorem uncommittedTraceRetainsTheActiveGeneration {α : Type} (active : Option α)
    (events : List (α × Phase × Bool × Bool))
    (h : ∀ event ∈ events, event.2.2.1 = false ∨
      (event.2.1 ≠ .complete ∧ (event.2.1 ≠ .uncertain ∨ event.2.2.2 = false))) :
    selections active events = active := by
  induction events generalizing active with
  | nil => rfl
  | cons event rest ih =>
    rcases event with ⟨candidate, phase, valid, observed⟩
    have here := h (candidate, phase, valid, observed) (by simp)
    have keep : select active candidate phase valid observed = active := by
      rcases here with rejected | ⟨incomplete, unobserved⟩
      · change valid = false at rejected
        simp [select, rejected]
      · change phase ≠ .complete at incomplete
        rcases unobserved with beforePublication | notObserved
        · change phase ≠ .uncertain at beforePublication
          simp [select, incomplete, beforePublication]
        · change observed = false at notObserved
          simp [select, incomplete, notObserved]
    simp only [selections, keep]
    apply ih
    intro event member
    exact h event (by simp [member])

def screeningResponse : Bool × Bool × Bool × Bool × Bool := (false, false, false, false, false)

theorem screeningNeverBlocksRejectsSilencesOrSkipsLogs :
    screeningResponse = (false, false, false, false, false) := rfl

def display (started now : Int) (found held : Bool) : Bool :=
  decide (started ≥ 0 ∧ now ≥ started ∧ now - started < 1000) && found && held

theorem callerDisplayRequiresARoleAndATimelyMatch (started now : Int) (found held : Bool)
    (h : display started now found held = true) :
    0 ≤ now - started ∧ now - started < 1000 ∧ found = true ∧ held = true := by
  simp [display, Bool.and_eq_true] at h
  rcases h with ⟨⟨⟨hStarted, hOrder, hBudget⟩, hFound⟩, hHeld⟩
  exact ⟨by omega, hBudget, hFound, hHeld⟩

theorem callerClockSubtractionFitsInt64 (started now : Int)
    (hStarted : started ≥ 0) (hNow : now ≥ started) (hMax : now ≤ 9223372036854775807) :
    0 ≤ now - started ∧ now - started ≤ 9223372036854775807 := by omega

theorem wordCountArithmeticFitsInt32 (words named placed : Int)
    (hWords : 0 ≤ words ∧ words ≤ 8) (hNamed : 0 ≤ named ∧ named ≤ words)
    (hPlaced : 0 ≤ placed ∧ placed ≤ words) :
    0 ≤ named + placed ∧ named + placed ≤ 2147483647 := by omega

structure ResponseState where
  sent : Bool
  count : Nat

def respond (state : ResponseState) : ResponseState :=
  if state.sent then state else ⟨true, state.count + 1⟩

theorem permissionResponseOccursOnce (state : ResponseState)
    (h : state.count = if state.sent then 1 else 0) :
    (respond state).sent = true ∧ (respond state).count = 1 := by
  rcases state with ⟨sent, count⟩
  cases sent <;> simp_all [respond]

theorem repeatedPermissionResponsesAreIdempotent (state : ResponseState) :
    respond (respond state) = respond state := by
  rcases state with ⟨sent, count⟩
  cases sent <;> simp [respond]

#print axioms admissionRequiresEveryCheck
#print axioms automaticTransfersAvoidRestrictedPaths
#print axioms answeredChecksWaitADay
#print axioms dueSubtractionFitsInt64
#print axioms acceptedChunksStayWithinTheFile
#print axioms acceptedChunkArithmeticFitsInt64
#print axioms acceptedCopiesReadOnlyBaseRows
#print axioms copyArithmeticFitsInt64
#print axioms unmatchedWordsReject
#print axioms regionMatchesRankAfterNameMatches
#print axioms prepublicationImportRetainsTheActiveGeneration
#print axioms rejectedImportRetainsTheActiveGeneration
#print axioms completeImportActivatesAsAUnit
#print axioms uncommittedTraceRetainsTheActiveGeneration
#print axioms screeningNeverBlocksRejectsSilencesOrSkipsLogs
#print axioms callerDisplayRequiresARoleAndATimelyMatch
#print axioms callerClockSubtractionFitsInt64
#print axioms wordCountArithmeticFitsInt32
#print axioms permissionResponseOccursOnce
#print axioms repeatedPermissionResponsesAreIdempotent
#print axioms uncertainCandidateSurvivesAbort
#print axioms activeCandidateSurvivesAbort
#print axioms acceptedJsonDepthIsBounded
#print axioms jsonDescentFitsInt32
#print axioms pageRestartRequiresGenerationChange
#print axioms pageAppendRequiresTheSameQuery
#print axioms activationRequiresIndexedAndValidatedCandidate
#print axioms unconfirmedPublicationRetainsTheActiveGeneration
#print axioms confirmedUncertainPublicationActivates
#print axioms killedMutantsRequireCompletedBehavior
#print axioms mutationCampaignRequiresEveryExpectedResult

end Phonebook.Android
