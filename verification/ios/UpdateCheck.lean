import Lean.Elab.Tactic.Omega

namespace Phonebook

/-! The update decision of `ios/Sources/PhonebookCore/UpdateCheck.swift`, function for function. -/

structure UpdatePath where
  expensive : Bool
  constrained : Bool
deriving DecidableEq

def UpdatePath.inexpensive (p : UpdatePath) : Bool := !p.expensive && !p.constrained

inductive UpdateTransfer where
  | delta
  | archive
deriving DecidableEq

inductive ListingReply where
  | failed
  | notModified
  | saved
  | delta
  | archive
deriving DecidableEq

structure UpdateState where
  answeredAt : Option Int
  waiting : Option UpdateTransfer
deriving DecidableEq

inductive UpdateEvent where
  | check (now : Int) (reply : ListingReply) (path : UpdatePath)
  | path (path : UpdatePath)
  | person (now : Int) (transfer : Option UpdateTransfer) (path : UpdatePath)
deriving DecidableEq

structure UpdateStart where
  transfer : UpdateTransfer
  automatic : Bool
  path : UpdatePath
deriving DecidableEq

structure UpdateStep where
  state : UpdateState
  read : Bool
  start : Option UpdateStart
deriving DecidableEq

def updateIntervalSeconds : Int := 86400

def updateDue (s : UpdateState) (now : Int) : Bool :=
  match s.answeredAt with
  | none => true
  | some answeredAt => decide (now - answeredAt ≥ updateIntervalSeconds)

def updateWanted : ListingReply → Option UpdateTransfer → Option UpdateTransfer
  | .failed, waiting => waiting
  | .notModified, waiting => waiting
  | .saved, _ => none
  | .delta, _ => some .delta
  | .archive, _ => some .archive

def updateStep (s : UpdateState) : UpdateEvent → UpdateStep
  | .check now reply path =>
    if updateDue s now && reply != .failed then
      match updateWanted reply s.waiting with
      | some transfer =>
        if reply != .notModified && path.inexpensive then
          ⟨⟨some now, none⟩, true, some ⟨transfer, true, path⟩⟩
        else ⟨⟨some now, some transfer⟩, true, none⟩
      | none => ⟨⟨some now, none⟩, true, none⟩
    else ⟨s, false, none⟩
  | .path path =>
    match s.waiting with
    | some waiting =>
      if path.inexpensive then ⟨⟨s.answeredAt, none⟩, false, some ⟨waiting, true, path⟩⟩
      else ⟨s, false, none⟩
    | none => ⟨s, false, none⟩
  | .person now transfer path =>
    ⟨⟨some now, none⟩, false, transfer.map fun t => ⟨t, false, path⟩⟩

def UpdateState.initial : UpdateState := ⟨none, none⟩

/-- The steps of a trace, which the Swift contract traces record. -/
def updateSteps : UpdateState → List UpdateEvent → List UpdateStep
  | _, [] => []
  | s, e :: rest => updateStep s e :: updateSteps (updateStep s e).state rest

/-- The transfers that a trace starts, in order. -/
def updateStarts : UpdateState → List UpdateEvent → List UpdateStart
  | _, [] => []
  | s, e :: rest =>
    (updateStep s e).start.toList ++ updateStarts (updateStep s e).state rest

/-- Each answered read comes from a check at least 86,400 seconds after the answered read before it. -/
def ReadsADayApart : UpdateState → List UpdateEvent → Prop
  | _, [] => True
  | s, e :: rest =>
    ((updateStep s e).read = true →
      ∃ now reply path, e = .check now reply path ∧
        (∀ a, s.answeredAt = some a → a + 86400 ≤ now) ∧
        (updateStep s e).state.answeredAt = some now) ∧
    ReadsADayApart (updateStep s e).state rest

theorem answeredReadsStayADayApart :
    ∀ (s : UpdateState) (events : List UpdateEvent), ReadsADayApart s events := by
  intro s events
  induction events generalizing s with
  | nil => trivial
  | cons e rest ih =>
    refine ⟨?_, ih _⟩
    intro hRead
    cases e with
    | check now reply path =>
      have hDue : updateDue s now = true := by
        cases hd : updateDue s now
        · simp [updateStep, hd] at hRead
        · rfl
      refine ⟨now, reply, path, rfl, ?_, ?_⟩
      · intro a ha
        simp [updateDue, ha, updateIntervalSeconds] at hDue
        omega
      · simp only [updateStep] at hRead ⊢
        have hCondition : (updateDue s now && reply != .failed) = true := by
          cases hc : (updateDue s now && reply != .failed)
          · rw [hc] at hRead
            simp at hRead
          · rfl
        simp only [hCondition, ↓reduceIte]
        split
        · split <;> rfl
        · rfl
    | path path =>
      simp only [updateStep] at hRead
      split at hRead
      · split at hRead <;> simp at hRead
      · simp at hRead
    | person now transfer path =>
      simp [updateStep] at hRead

/-- No automatic transfer starts on an expensive or a constrained path, on any trace. -/
theorem noAutomaticTransferOnACostlyPath :
    ∀ (s : UpdateState) (events : List UpdateEvent) (start : UpdateStart),
      start ∈ updateStarts s events → start.automatic = true →
        start.path.expensive = false ∧ start.path.constrained = false := by
  intro s events
  induction events generalizing s with
  | nil => intro start hStart; simp [updateStarts] at hStart
  | cons e rest ih =>
    intro start hStart hAutomatic
    simp only [updateStarts, List.mem_append] at hStart
    rcases hStart with hHere | hLater
    · have hCheap : start.path.inexpensive = true := by
        cases e with
        | check now reply path =>
          simp only [updateStep] at hHere
          split at hHere <;> (try split at hHere) <;> (try split at hHere) <;> simp_all
        | path path =>
          simp only [updateStep] at hHere
          split at hHere <;> (try split at hHere) <;> simp_all
        | person now transfer path =>
          cases transfer <;> simp only [updateStep] at hHere <;> (try split at hHere) <;>
            simp_all
      simp only [UpdatePath.inexpensive, Bool.and_eq_true, Bool.not_eq_true'] at hCheap
      exact hCheap
    · exact ih _ start hLater hAutomatic

/-- A transfer that waits starts on the first path that is neither expensive nor constrained,
and a transfer that a check names starts at once on such a path. -/
theorem automaticTransferStartsOnAnInexpensivePath :
    (∀ (s : UpdateState) (transfer : UpdateTransfer) (path : UpdatePath),
      s.waiting = some transfer → path.expensive = false → path.constrained = false →
        (updateStep s (.path path)).start = some ⟨transfer, true, path⟩) ∧
    (∀ (s : UpdateState) (now : Int) (path : UpdatePath),
      updateDue s now = true → path.expensive = false → path.constrained = false →
        (updateStep s (.check now .delta path)).start = some ⟨.delta, true, path⟩ ∧
        (updateStep s (.check now .archive path)).start = some ⟨.archive, true, path⟩) := by
  constructor
  · intro s transfer path hWaiting hExpensive hConstrained
    simp_all [updateStep, UpdatePath.inexpensive]
  · intro s now path hDue hExpensive hConstrained
    simp_all [updateStep, updateWanted, UpdatePath.inexpensive]

/-- A transfer that the person starts begins on every path, including mobile data and Low Data Mode. -/
theorem personTransfersUseEveryPath :
    ∀ (s : UpdateState) (now : Int) (transfer : UpdateTransfer) (path : UpdatePath),
      (updateStep s (.person now (some transfer) path)).start = some ⟨transfer, false, path⟩ := by
  intro s now transfer path
  simp [updateStep]

/-- A 304 reply or a listing of the saved snapshot starts no transfer. -/
theorem unchangedListingsStartNothing :
    ∀ (s : UpdateState) (now : Int) (path : UpdatePath),
      (updateStep s (.check now .notModified path)).start = none ∧
      (updateStep s (.check now .saved path)).start = none := by
  intro s now path
  constructor
  · simp only [updateStep]
    split
    · split
      · split
        · rename_i hCondition
          simp at hCondition
        · rfl
      · rfl
    · rfl
  · simp only [updateStep]
    split
    · simp [updateWanted]
    · rfl

#print axioms answeredReadsStayADayApart
#print axioms noAutomaticTransferOnACostlyPath
#print axioms automaticTransferStartsOnAnInexpensivePath
#print axioms personTransfersUseEveryPath
#print axioms unchangedListingsStartNothing

end Phonebook
