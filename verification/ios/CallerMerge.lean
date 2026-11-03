import Lean.Elab.Tactic.Omega

namespace Phonebook

inductive CallerMerge where
  | national
  | extraFirst
  | extraReplaces
deriving DecidableEq

def decideMerge (extra national : Int) : CallerMerge :=
  if extra < national then .extraFirst
  else if extra = national then .extraReplaces
  else .national

/-- The entries that the Call Directory extension passes to CallKit, one national record at a time. -/
def mergeCallers : Option (Int × String) → List (Int × String) → List (Int × String)
  | none, national => national
  | some extra, [] => [extra]
  | some extra, entry :: rest =>
    match decideMerge extra.1 entry.1 with
    | .national => entry :: mergeCallers (some extra) rest
    | .extraFirst => extra :: entry :: rest
    | .extraReplaces => extra :: rest

def Ascending (entries : List (Int × String)) : Prop :=
  entries.Pairwise (fun a b => a.1 < b.1)

theorem extraGoesFirstExactlyBelow (extra national : Int) :
    decideMerge extra national = .extraFirst ↔ extra < national := by
  unfold decideMerge
  by_cases hLess : extra < national
  · simp [hLess]
  · by_cases hSame : extra = national
    · simp [hSame]
    · simp [hLess, hSame]

theorem extraReplacesExactlyTheSameNumber (extra national : Int) :
    decideMerge extra national = .extraReplaces ↔ extra = national := by
  unfold decideMerge
  by_cases hLess : extra < national
  · have hDiffer : extra ≠ national := by omega
    simp [hLess, hDiffer]
  · by_cases hSame : extra = national
    · simp [hSame]
    · simp [hLess, hSame]

theorem nationalPassesExactlyBelowTheExtra (extra national : Int) :
    decideMerge extra national = .national ↔ national < extra := by
  unfold decideMerge
  by_cases hLess : extra < national
  · have hAbove : ¬ national < extra := by omega
    simp [hLess, hAbove]
  · by_cases hSame : extra = national
    · simp [hSame]
    · have hAbove : national < extra := by omega
      simp [hLess, hSame, hAbove]

theorem withoutAnExtraTheNationalEntriesPassUnchanged (national : List (Int × String)) :
    mergeCallers none national = national := by
  simp [mergeCallers]

theorem mergedEntriesComeFromTheExtraOrTheNationalFile (extra : Int × String) :
    ∀ (national : List (Int × String)) (entry : Int × String),
      entry ∈ mergeCallers (some extra) national → entry = extra ∨ entry ∈ national := by
  intro national
  induction national with
  | nil =>
    intro entry hEntry
    simp [mergeCallers] at hEntry
    exact Or.inl hEntry
  | cons head rest ih =>
    intro entry hEntry
    simp only [mergeCallers] at hEntry
    split at hEntry
    · rcases List.mem_cons.mp hEntry with hHead | hRest
      · exact Or.inr (List.mem_cons.mpr (Or.inl hHead))
      · rcases ih entry hRest with hExtra | hIn
        · exact Or.inl hExtra
        · exact Or.inr (List.mem_cons.mpr (Or.inr hIn))
    · rcases List.mem_cons.mp hEntry with hExtra | hIn
      · exact Or.inl hExtra
      · exact Or.inr hIn
    · rcases List.mem_cons.mp hEntry with hExtra | hRest
      · exact Or.inl hExtra
      · exact Or.inr (List.mem_cons.mpr (Or.inr hRest))

theorem theExtraEntryIsAlwaysMerged (extra : Int × String) :
    ∀ national : List (Int × String), extra ∈ mergeCallers (some extra) national := by
  intro national
  induction national with
  | nil => simp [mergeCallers]
  | cons head rest ih =>
    simp only [mergeCallers]
    split
    · exact List.mem_cons.mpr (Or.inr ih)
    · exact List.mem_cons.mpr (Or.inl rfl)
    · exact List.mem_cons.mpr (Or.inl rfl)

theorem otherNumbersKeepTheirNationalEntries (extra : Int × String) :
    ∀ (national : List (Int × String)) (entry : Int × String),
      entry ∈ national → entry.1 ≠ extra.1 → entry ∈ mergeCallers (some extra) national := by
  intro national
  induction national with
  | nil =>
    intro entry hEntry
    simp at hEntry
  | cons head rest ih =>
    intro entry hEntry hNumber
    simp only [mergeCallers]
    split
    · rcases List.mem_cons.mp hEntry with hHead | hRest
      · exact List.mem_cons.mpr (Or.inl hHead)
      · exact List.mem_cons.mpr (Or.inr (ih entry hRest hNumber))
    · exact List.mem_cons.mpr (Or.inr hEntry)
    · rename_i hDecision
      have hSame : extra.1 = head.1 :=
        (extraReplacesExactlyTheSameNumber extra.1 head.1).mp hDecision
      rcases List.mem_cons.mp hEntry with hHead | hRest
      · subst hHead
        exact absurd hSame.symm hNumber
      · exact List.mem_cons.mpr (Or.inr hRest)

theorem mergedCallersStayAscending (extra : Int × String) :
    ∀ national : List (Int × String),
      Ascending national → Ascending (mergeCallers (some extra) national) := by
  intro national
  induction national with
  | nil =>
    intro _
    simp [mergeCallers, Ascending]
  | cons head rest ih =>
    intro hAscending
    have hSplit := List.pairwise_cons.mp hAscending
    have hAbove : ∀ entry ∈ rest, head.1 < entry.1 := hSplit.1
    have hRest : Ascending rest := hSplit.2
    simp only [mergeCallers]
    split
    · rename_i hDecision
      have hBelow : head.1 < extra.1 :=
        (nationalPassesExactlyBelowTheExtra extra.1 head.1).mp hDecision
      refine List.pairwise_cons.mpr ⟨?_, ih hRest⟩
      intro entry hEntry
      rcases mergedEntriesComeFromTheExtraOrTheNationalFile extra rest entry hEntry with
        hExtra | hIn
      · subst hExtra
        exact hBelow
      · exact hAbove entry hIn
    · rename_i hDecision
      have hLess : extra.1 < head.1 :=
        (extraGoesFirstExactlyBelow extra.1 head.1).mp hDecision
      refine List.pairwise_cons.mpr ⟨?_, hAscending⟩
      intro entry hEntry
      rcases List.mem_cons.mp hEntry with hHead | hIn
      · subst hHead
        exact hLess
      · have := hAbove entry hIn
        omega
    · rename_i hDecision
      have hSame : extra.1 = head.1 :=
        (extraReplacesExactlyTheSameNumber extra.1 head.1).mp hDecision
      refine List.pairwise_cons.mpr ⟨?_, hRest⟩
      intro entry hIn
      have := hAbove entry hIn
      omega

theorem theExtraLabelWinsItsNumber (extra : Int × String) :
    ∀ national : List (Int × String), Ascending national →
      ∀ entry ∈ mergeCallers (some extra) national, entry.1 = extra.1 → entry = extra := by
  intro national
  induction national with
  | nil =>
    intro _ entry hEntry _
    simpa [mergeCallers] using hEntry
  | cons head rest ih =>
    intro hAscending entry hEntry hNumber
    have hSplit := List.pairwise_cons.mp hAscending
    have hAbove : ∀ entry ∈ rest, head.1 < entry.1 := hSplit.1
    have hRest : Ascending rest := hSplit.2
    simp only [mergeCallers] at hEntry
    split at hEntry
    · rename_i hDecision
      have hBelow : head.1 < extra.1 :=
        (nationalPassesExactlyBelowTheExtra extra.1 head.1).mp hDecision
      rcases List.mem_cons.mp hEntry with hHead | hIn
      · subst hHead
        omega
      · exact ih hRest entry hIn hNumber
    · rename_i hDecision
      have hLess : extra.1 < head.1 :=
        (extraGoesFirstExactlyBelow extra.1 head.1).mp hDecision
      rcases List.mem_cons.mp hEntry with hExtra | hNational
      · exact hExtra
      · rcases List.mem_cons.mp hNational with hHead | hIn
        · subst hHead
          omega
        · have := hAbove entry hIn
          omega
    · rename_i hDecision
      have hSame : extra.1 = head.1 :=
        (extraReplacesExactlyTheSameNumber extra.1 head.1).mp hDecision
      rcases List.mem_cons.mp hEntry with hExtra | hIn
      · exact hExtra
      · have := hAbove entry hIn
        omega

#print axioms extraGoesFirstExactlyBelow
#print axioms extraReplacesExactlyTheSameNumber
#print axioms nationalPassesExactlyBelowTheExtra
#print axioms withoutAnExtraTheNationalEntriesPassUnchanged
#print axioms mergedEntriesComeFromTheExtraOrTheNationalFile
#print axioms theExtraEntryIsAlwaysMerged
#print axioms otherNumbersKeepTheirNationalEntries
#print axioms mergedCallersStayAscending
#print axioms theExtraLabelWinsItsNumber

end Phonebook
