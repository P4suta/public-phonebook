import CallerMerge

namespace Phonebook

/-- What one step of the walk over two ascending caller lists does with the next held and the next wanted entry. -/
inductive CallerChange where
  | remove
  | add
  | keep
  | replace
deriving DecidableEq

def decideChange (held wanted : Int × String) : CallerChange :=
  if held.1 < wanted.1 then .remove
  else if wanted.1 < held.1 then .add
  else if held.2 = wanted.2 then .keep
  else .replace

/-- The numbers to remove from what iOS holds and the entries to add, in ascending order. -/
def diffCallers (held wanted : List (Int × String)) : List Int × List (Int × String) :=
  match held, wanted with
  | [], wanted => ([], wanted)
  | held, [] => (held.map Prod.fst, [])
  | h :: hs, w :: ws =>
    match decideChange h w with
    | .remove => let r := diffCallers hs (w :: ws); (h.1 :: r.1, r.2)
    | .add => let r := diffCallers (h :: hs) ws; (r.1, w :: r.2)
    | .keep => diffCallers hs ws
    | .replace => let r := diffCallers hs ws; (h.1 :: r.1, w :: r.2)
termination_by held.length + wanted.length

def labelOf (number : Int) : List (Int × String) → Option String
  | [] => none
  | entry :: rest => if entry.1 = number then some entry.2 else labelOf number rest

/-- The label that iOS gives `number` after a request removes `removed` from `held` and then adds `added`. -/
def labelAfter (held : List (Int × String)) (removed : List Int) (added : List (Int × String))
    (number : Int) : Option String :=
  match labelOf number added with
  | some label => some label
  | none => if number ∈ removed then none else labelOf number held

theorem removeExactlyBelow (h w : Int × String) :
    decideChange h w = .remove ↔ h.1 < w.1 := by
  unfold decideChange
  by_cases a : h.1 < w.1
  · simp [a]
  · by_cases b : w.1 < h.1
    · simp [a, b]
    · by_cases c : h.2 = w.2 <;> simp [a, b, c]

theorem addExactlyAbove (h w : Int × String) :
    decideChange h w = .add ↔ w.1 < h.1 := by
  unfold decideChange
  by_cases a : h.1 < w.1
  · have : ¬ w.1 < h.1 := by omega
    simp [a, this]
  · by_cases b : w.1 < h.1
    · simp [a, b]
    · by_cases c : h.2 = w.2 <;> simp [a, b, c]

theorem keepExactlyTheSameEntry (h w : Int × String) :
    decideChange h w = .keep ↔ h.1 = w.1 ∧ h.2 = w.2 := by
  unfold decideChange
  by_cases a : h.1 < w.1
  · have : h.1 ≠ w.1 := by omega
    simp [a, this]
  · by_cases b : w.1 < h.1
    · have : h.1 ≠ w.1 := by omega
      simp [a, b, this]
    · have : h.1 = w.1 := by omega
      by_cases c : h.2 = w.2 <;> simp [c, this]

theorem replaceExactlyAnotherLabel (h w : Int × String) :
    decideChange h w = .replace ↔ h.1 = w.1 ∧ h.2 ≠ w.2 := by
  unfold decideChange
  by_cases a : h.1 < w.1
  · have : h.1 ≠ w.1 := by omega
    simp [a, this]
  · by_cases b : w.1 < h.1
    · have : h.1 ≠ w.1 := by omega
      simp [a, b, this]
    · have : h.1 = w.1 := by omega
      by_cases c : h.2 = w.2 <;> simp [c, this]

theorem labelOfAbsent (number : Int) :
    ∀ entries : List (Int × String), (∀ e ∈ entries, e.1 ≠ number) →
      labelOf number entries = none := by
  intro entries
  induction entries with
  | nil => intro _; rfl
  | cons head rest ih =>
    intro hAll
    have hHead : head.1 ≠ number := hAll head (List.mem_cons_self ..)
    simp only [labelOf, hHead, ite_false]
    exact ih (fun e he => hAll e (List.mem_cons_of_mem _ he))

theorem labelOfAscendingHead (head : Int × String) (rest : List (Int × String)) :
    labelOf head.1 (head :: rest) = some head.2 := by
  simp [labelOf]

theorem labelOfOther (number : Int) (head : Int × String) (rest : List (Int × String))
    (h : head.1 ≠ number) : labelOf number (head :: rest) = labelOf number rest := by
  simp [labelOf, h]

theorem diffShape (held wanted : List (Int × String)) :
    (diffCallers held wanted).1.Sublist (held.map Prod.fst) ∧
      (diffCallers held wanted).2.Sublist wanted := by
  induction held, wanted using diffCallers.induct with
  | case1 wanted => simp [diffCallers]
  | case2 held hNil =>
    cases held with
    | nil => simp [diffCallers]
    | cons h hs => simp [diffCallers]
  | case3 h hs w ws hDecision ih =>
    simp only [diffCallers, hDecision]
    exact ⟨List.Sublist.cons_cons _ ih.1, ih.2⟩
  | case4 h hs w ws hDecision ih =>
    simp only [diffCallers, hDecision]
    exact ⟨ih.1, List.Sublist.cons_cons _ ih.2⟩
  | case5 h hs w ws hDecision ih =>
    simp only [diffCallers, hDecision]
    exact ⟨List.Sublist.cons _ ih.1, List.Sublist.cons _ ih.2⟩
  | case6 h hs w ws hDecision ih =>
    simp only [diffCallers, hDecision]
    exact ⟨List.Sublist.cons_cons _ ih.1, List.Sublist.cons_cons _ ih.2⟩

theorem removedNumbersComeFromTheHeldEntries (held wanted : List (Int × String)) :
    ∀ number ∈ (diffCallers held wanted).1, ∃ label, (number, label) ∈ held := by
  intro number hNumber
  obtain ⟨e, he, hKey⟩ := List.mem_map.mp ((diffShape held wanted).1.subset hNumber)
  exact ⟨e.2, by subst hKey; exact he⟩

theorem addedEntriesComeFromTheWantedEntries (held wanted : List (Int × String)) :
    ∀ e ∈ (diffCallers held wanted).2, e ∈ wanted :=
  fun _ he => (diffShape held wanted).2.subset he

theorem removalsAscend (held wanted : List (Int × String)) (hHeld : Ascending held) :
    (diffCallers held wanted).1.Pairwise (· < ·) :=
  (List.pairwise_map.mpr hHeld).sublist (diffShape held wanted).1

theorem removalsNameEachNumberOnce (held wanted : List (Int × String)) (hHeld : Ascending held) :
    (diffCallers held wanted).1.Nodup :=
  (removalsAscend held wanted hHeld).imp (fun hLess => by omega)

theorem additionsAscend (held wanted : List (Int × String)) (hWanted : Ascending wanted) :
    Ascending (diffCallers held wanted).2 :=
  hWanted.sublist (diffShape held wanted).2

/-- Applying the removals and then the additions to the held entries yields the wanted entries for every number. -/
theorem theChangesTurnTheHeldEntriesIntoTheWantedOnes (held wanted : List (Int × String)) :
    Ascending held → Ascending wanted → ∀ number,
      labelAfter held (diffCallers held wanted).1 (diffCallers held wanted).2 number =
        labelOf number wanted := by
  induction held, wanted using diffCallers.induct with
  | case1 wanted =>
    intro _ _ number
    simp only [diffCallers, labelAfter]
    cases labelOf number wanted <;> simp [labelOf]
  | case2 held hNil =>
    intro _ _ number
    cases held with
    | nil => exact absurd rfl hNil
    | cons h hs =>
      have hEmpty : labelOf number [] = none := rfl
      simp only [diffCallers, labelAfter, hEmpty]
      split
      · rfl
      · rename_i hRemoved
        apply labelOfAbsent
        intro e he hKey
        exact hRemoved (List.mem_map.mpr ⟨e, he, hKey⟩)
  | case3 h hs w ws hDecision ih =>
    intro hHeld hWanted number
    simp only [diffCallers, hDecision]
    have hLess := (removeExactlyBelow h w).mp hDecision
    have hRest := ih (List.pairwise_cons.mp hHeld).2 hWanted number
    have hWantedAbove : ∀ e ∈ w :: ws, h.1 < e.1 := by
      intro e he
      rcases List.mem_cons.mp he with hHead | hTail
      · subst hHead; exact hLess
      · have := (List.pairwise_cons.mp hWanted).1 e hTail; omega
    by_cases hSame : number = h.1
    · subst hSame
      have hNotAdded : labelOf h.1 (diffCallers hs (w :: ws)).2 = none := by
        apply labelOfAbsent
        intro e he
        have := hWantedAbove e (addedEntriesComeFromTheWantedEntries hs (w :: ws) e he)
        omega
      have hNotWanted : labelOf h.1 (w :: ws) = none := by
        apply labelOfAbsent
        intro e he
        have := hWantedAbove e he
        omega
      simp [labelAfter, hNotAdded, hNotWanted]
    · rw [← hRest]
      simp only [labelAfter, List.mem_cons, hSame, false_or]
      rw [labelOfOther number h hs (Ne.symm hSame)]
  | case4 h hs w ws hDecision ih =>
    intro hHeld hWanted number
    simp only [diffCallers, hDecision]
    have hRest := ih hHeld (List.pairwise_cons.mp hWanted).2 number
    by_cases hSame : number = w.1
    · subst hSame
      simp [labelAfter, labelOf]
    · rw [labelOfOther number w ws (Ne.symm hSame), ← hRest]
      simp only [labelAfter]
      rw [labelOfOther number w _ (Ne.symm hSame)]
  | case5 h hs w ws hDecision ih =>
    intro hHeld hWanted number
    simp only [diffCallers, hDecision]
    have hKeep := (keepExactlyTheSameEntry h w).mp hDecision
    have hRest := ih (List.pairwise_cons.mp hHeld).2 (List.pairwise_cons.mp hWanted).2 number
    by_cases hSame : number = h.1
    · subst hSame
      have hNotAdded : labelOf h.1 (diffCallers hs ws).2 = none := by
        apply labelOfAbsent
        intro e he
        have := (List.pairwise_cons.mp hWanted).1 e (addedEntriesComeFromTheWantedEntries hs ws e he)
        omega
      have hNotRemoved : h.1 ∉ (diffCallers hs ws).1 := by
        intro hIn
        obtain ⟨label, hMember⟩ := removedNumbersComeFromTheHeldEntries hs ws h.1 hIn
        have := (List.pairwise_cons.mp hHeld).1 _ hMember
        simp at this
      have hWantedHead : labelOf h.1 (w :: ws) = some w.2 := by
        rw [hKeep.1]; exact labelOfAscendingHead w ws
      simp only [labelAfter, hNotAdded, hNotRemoved, ite_false, labelOfAscendingHead,
        hWantedHead, hKeep.2]
    · rw [labelOfOther number w ws (by rw [← hKeep.1]; exact Ne.symm hSame), ← hRest]
      simp only [labelAfter]
      rw [labelOfOther number h hs (Ne.symm hSame)]
  | case6 h hs w ws hDecision ih =>
    intro hHeld hWanted number
    simp only [diffCallers, hDecision]
    have hReplace := (replaceExactlyAnotherLabel h w).mp hDecision
    have hRest := ih (List.pairwise_cons.mp hHeld).2 (List.pairwise_cons.mp hWanted).2 number
    by_cases hSame : number = h.1
    · subst hSame
      have hWantedHead : labelOf h.1 (w :: ws) = some w.2 := by
        rw [hReplace.1]; exact labelOfAscendingHead w ws
      simp only [labelAfter, hWantedHead]
      rw [hReplace.1, labelOfAscendingHead]
    · have hOther : w.1 ≠ number := by rw [← hReplace.1]; exact Ne.symm hSame
      rw [labelOfOther number w ws hOther, ← hRest]
      simp only [labelAfter, List.mem_cons, hSame, false_or]
      rw [labelOfOther number w _ hOther, labelOfOther number h hs (Ne.symm hSame)]

/-- An addition never meets an entry that iOS still holds, so the request adds no duplicate number. -/
theorem everyAddedNumberIsFreeOrRemoved (held wanted : List (Int × String)) :
    Ascending held → Ascending wanted → ∀ e ∈ (diffCallers held wanted).2,
      labelOf e.1 held = none ∨ e.1 ∈ (diffCallers held wanted).1 := by
  induction held, wanted using diffCallers.induct with
  | case1 wanted =>
    intro _ _ e _
    exact Or.inl rfl
  | case2 held hNil =>
    intro _ _ e he
    cases held with
    | nil => exact absurd rfl hNil
    | cons h hs => simp [diffCallers] at he
  | case3 h hs w ws hDecision ih =>
    intro hHeld hWanted e he
    simp only [diffCallers, hDecision] at he ⊢
    rcases ih (List.pairwise_cons.mp hHeld).2 hWanted e he with hFree | hRemoved
    · by_cases hSame : h.1 = e.1
      · exact Or.inr (List.mem_cons.mpr (Or.inl hSame.symm))
      · exact Or.inl (by rw [labelOfOther e.1 h hs hSame]; exact hFree)
    · exact Or.inr (List.mem_cons_of_mem _ hRemoved)
  | case4 h hs w ws hDecision ih =>
    intro hHeld hWanted e he
    simp only [diffCallers, hDecision] at he ⊢
    have hGreater := (addExactlyAbove h w).mp hDecision
    rcases List.mem_cons.mp he with hHead | hTail
    · subst hHead
      left
      apply labelOfAbsent
      intro x hx
      rcases List.mem_cons.mp hx with hx | hx
      · subst hx; omega
      · have := (List.pairwise_cons.mp hHeld).1 x hx; omega
    · exact ih hHeld (List.pairwise_cons.mp hWanted).2 e hTail
  | case5 h hs w ws hDecision ih =>
    intro hHeld hWanted e he
    simp only [diffCallers, hDecision] at he ⊢
    have hKeep := (keepExactlyTheSameEntry h w).mp hDecision
    have hAbove := (List.pairwise_cons.mp hWanted).1 e (addedEntriesComeFromTheWantedEntries hs ws e he)
    rcases ih (List.pairwise_cons.mp hHeld).2 (List.pairwise_cons.mp hWanted).2 e he with hFree | hRemoved
    · exact Or.inl (by rw [labelOfOther e.1 h hs (by omega)]; exact hFree)
    · exact Or.inr hRemoved
  | case6 h hs w ws hDecision ih =>
    intro hHeld hWanted e he
    simp only [diffCallers, hDecision] at he ⊢
    have hReplace := (replaceExactlyAnotherLabel h w).mp hDecision
    rcases List.mem_cons.mp he with hHead | hTail
    · subst hHead
      exact Or.inr (List.mem_cons.mpr (Or.inl hReplace.1.symm))
    · have hAbove := (List.pairwise_cons.mp hWanted).1 e (addedEntriesComeFromTheWantedEntries hs ws e hTail)
      rcases ih (List.pairwise_cons.mp hHeld).2 (List.pairwise_cons.mp hWanted).2 e hTail with hFree | hRemoved
      · exact Or.inl (by rw [labelOfOther e.1 h hs (by omega)]; exact hFree)
      · exact Or.inr (List.mem_cons_of_mem _ hRemoved)

theorem labelOfMember (entries : List (Int × String)) (hAscending : Ascending entries) :
    ∀ e ∈ entries, labelOf e.1 entries = some e.2 := by
  induction entries with
  | nil => intro e he; simp at he
  | cons head rest ih =>
    intro e he
    have hSplit := List.pairwise_cons.mp hAscending
    rcases List.mem_cons.mp he with hHead | hRest
    · subst hHead
      exact labelOfAscendingHead e rest
    · have hAbove : head.1 < e.1 := hSplit.1 e hRest
      rw [labelOfOther e.1 head rest (by omega)]
      exact ih hSplit.2 e hRest

theorem removedNumbersLieAboveTheHead (h : Int × String) (hs wanted : List (Int × String))
    (hHeld : Ascending (h :: hs)) : ∀ number ∈ (diffCallers hs wanted).1, h.1 < number := by
  intro number hNumber
  obtain ⟨label, hMember⟩ := removedNumbersComeFromTheHeldEntries hs wanted number hNumber
  exact (List.pairwise_cons.mp hHeld).1 _ hMember

/-- Every change sits at a number where the held and the wanted entries differ. -/
theorem changesSitWhereTheListsDiffer (held wanted : List (Int × String)) :
    Ascending held → Ascending wanted →
      (∀ number ∈ (diffCallers held wanted).1, labelOf number held ≠ labelOf number wanted) ∧
        (∀ e ∈ (diffCallers held wanted).2, labelOf e.1 held ≠ some e.2) := by
  induction held, wanted using diffCallers.induct with
  | case1 wanted =>
    intro _ _
    simp [diffCallers, labelOf]
  | case2 held hNil =>
    intro hHeld _
    cases held with
    | nil => exact absurd rfl hNil
    | cons h hs =>
      simp only [diffCallers]
      refine ⟨?_, by simp⟩
      intro number hNumber
      obtain ⟨e, he, hKey⟩ := List.mem_map.mp hNumber
      subst hKey
      rw [labelOfMember (h :: hs) hHeld e he]
      simp [labelOf]
  | case3 h hs w ws hDecision ih =>
    intro hHeld hWanted
    simp only [diffCallers, hDecision]
    have hLess := (removeExactlyBelow h w).mp hDecision
    have hRest := ih (List.pairwise_cons.mp hHeld).2 hWanted
    have hWantedAbove : ∀ e ∈ w :: ws, h.1 < e.1 := by
      intro e he
      rcases List.mem_cons.mp he with hHead | hTail
      · subst hHead; exact hLess
      · have := (List.pairwise_cons.mp hWanted).1 e hTail; omega
    refine ⟨?_, ?_⟩
    · intro number hNumber
      rcases List.mem_cons.mp hNumber with hHead | hTail
      · subst hHead
        rw [labelOfAscendingHead, labelOfAbsent h.1 (w :: ws) (fun e he => by
          have := hWantedAbove e he; omega)]
        simp
      · have hAbove := removedNumbersLieAboveTheHead h hs (w :: ws) hHeld number hTail
        rw [labelOfOther number h hs (by omega)]
        exact hRest.1 number hTail
    · intro e he
      have hAbove := hWantedAbove e (addedEntriesComeFromTheWantedEntries hs (w :: ws) e he)
      rw [labelOfOther e.1 h hs (by omega)]
      exact hRest.2 e he
  | case4 h hs w ws hDecision ih =>
    intro hHeld hWanted
    simp only [diffCallers, hDecision]
    have hGreater := (addExactlyAbove h w).mp hDecision
    have hRest := ih hHeld (List.pairwise_cons.mp hWanted).2
    refine ⟨?_, ?_⟩
    · intro number hNumber
      obtain ⟨label, hMember⟩ := removedNumbersComeFromTheHeldEntries (h :: hs) ws number hNumber
      have hAtLeast : h.1 ≤ number := by
        rcases List.mem_cons.mp hMember with hHead | hTail
        · rw [← hHead]; exact Int.le_refl _
        · have := (List.pairwise_cons.mp hHeld).1 _ hTail; simp at this; omega
      rw [labelOfOther number w ws (by omega)]
      exact hRest.1 number hNumber
    · intro e he
      rcases List.mem_cons.mp he with hHead | hTail
      · subst hHead
        rw [labelOfAbsent e.1 (h :: hs) (fun x hx => by
          rcases List.mem_cons.mp hx with hx | hx
          · subst hx; omega
          · have := (List.pairwise_cons.mp hHeld).1 x hx; omega)]
        simp
      · exact hRest.2 e hTail
  | case5 h hs w ws hDecision ih =>
    intro hHeld hWanted
    simp only [diffCallers, hDecision]
    have hKeep := (keepExactlyTheSameEntry h w).mp hDecision
    have hRest := ih (List.pairwise_cons.mp hHeld).2 (List.pairwise_cons.mp hWanted).2
    refine ⟨?_, ?_⟩
    · intro number hNumber
      have hAbove := removedNumbersLieAboveTheHead h hs ws hHeld number hNumber
      rw [labelOfOther number h hs (by omega), labelOfOther number w ws (by omega)]
      exact hRest.1 number hNumber
    · intro e he
      have hAbove :=
        (List.pairwise_cons.mp hWanted).1 e (addedEntriesComeFromTheWantedEntries hs ws e he)
      rw [labelOfOther e.1 h hs (by omega)]
      exact hRest.2 e he
  | case6 h hs w ws hDecision ih =>
    intro hHeld hWanted
    simp only [diffCallers, hDecision]
    have hReplace := (replaceExactlyAnotherLabel h w).mp hDecision
    have hRest := ih (List.pairwise_cons.mp hHeld).2 (List.pairwise_cons.mp hWanted).2
    refine ⟨?_, ?_⟩
    · intro number hNumber
      rcases List.mem_cons.mp hNumber with hHead | hTail
      · subst hHead
        rw [labelOfAscendingHead, hReplace.1, labelOfAscendingHead]
        simp [hReplace.2]
      · have hAbove := removedNumbersLieAboveTheHead h hs ws hHeld number hTail
        rw [labelOfOther number h hs (by omega), labelOfOther number w ws (by omega)]
        exact hRest.1 number hTail
    · intro e he
      rcases List.mem_cons.mp he with hHead | hTail
      · subst hHead
        rw [← hReplace.1, labelOfAscendingHead]
        simp [hReplace.2]
      · have hAbove :=
          (List.pairwise_cons.mp hWanted).1 e (addedEntriesComeFromTheWantedEntries hs ws e hTail)
        rw [labelOfOther e.1 h hs (by omega)]
        exact hRest.2 e hTail

theorem equalListsNeedNoChange :
    ∀ entries : List (Int × String), diffCallers entries entries = ([], []) := by
  intro entries
  induction entries with
  | nil => simp [diffCallers]
  | cons head rest ih =>
    have hKeep : decideChange head head = .keep :=
      (keepExactlyTheSameEntry head head).mpr ⟨rfl, rfl⟩
    simp [diffCallers, hKeep, ih]

#print axioms removeExactlyBelow
#print axioms addExactlyAbove
#print axioms keepExactlyTheSameEntry
#print axioms replaceExactlyAnotherLabel
#print axioms removedNumbersComeFromTheHeldEntries
#print axioms addedEntriesComeFromTheWantedEntries
#print axioms removalsAscend
#print axioms removalsNameEachNumberOnce
#print axioms additionsAscend
#print axioms theChangesTurnTheHeldEntriesIntoTheWantedOnes
#print axioms everyAddedNumberIsFreeOrRemoved
#print axioms changesSitWhereTheListsDiffer
#print axioms equalListsNeedNoChange

end Phonebook
