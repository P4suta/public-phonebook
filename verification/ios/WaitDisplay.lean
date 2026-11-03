import Lean.Elab.Tactic.Omega

namespace Phonebook

inductive WaitLine where
  | measuring
  | countdown
  | longer
  | almostDone
  | weakSignal
deriving DecidableEq

structure WaitInput where
  now : Int
  stage : Int
  done : Int
  total : Int
  rows : Int
  complete : Bool
deriving DecidableEq

structure WaitChoice where
  line : WaitLine
  seconds : Int
  minutes : Int
  deadline : Int
  stableSince : Int
deriving DecidableEq

def firstEstimateMs : Int := 500
def lineHoldMs : Int := 1000
def stepHoldMs : Int := 600
def fastRunMs : Int := 2000
def fastLimitMs : Int := 4000
def almostMs : Int := 3000
def almostSeconds : Int := 3
def shortMs : Int := 60000
def slackMs : Int := 3000
def stableMs : Int := 3000
def minuteHoldMs : Int := 10000
def stallMs : Int := 10000
def millisecondsPerSecond : Int := 1000
def millisecondsPerMinute : Int := 60000
def preparePerKiloRowMs : Int := 7
def identifyPerKiloRowMs : Int := 3
def rowsPerKilo : Int := 1000
def lastStage : Int := 2
def maximumMilliseconds : Int := 2147483647
def maximumCount : Int := 268435456
def unshownSeconds : Int := 2147483647

structure Wait where
  now : Int
  line : WaitLine
  seconds : Int
  minutes : Int
  changedAt : Int
  shown : Int
  shownAt : Int
  finished : Bool
  fast : Bool
  deadline : Int
  stableSince : Int
  stage : Int
  total : Int
  baseAt : Int
  baseDone : Int
  lastDone : Int
  progressAt : Int
  identifyEnd : Int
  identifyBudget : Int
deriving DecidableEq

def Wait.initial : Wait :=
  { now := 0, line := .measuring, seconds := unshownSeconds, minutes := 1, changedAt := 0,
    shown := 0, shownAt := 0, finished := false, fast := false, deadline := 0,
    stableSince := -1, stage := 0, total := 0, baseAt := 0, baseDone := 0, lastDone := 0,
    progressAt := 0, identifyEnd := 0, identifyBudget := 0 }

def clamp (value low high : Int) : Int := min (max value low) high

def ceilSeconds (milliseconds : Int) : Int :=
  (max milliseconds 0 + millisecondsPerSecond - 1) / millisecondsPerSecond

def coarseMinutes (milliseconds : Int) : Int :=
  max 1 ((max milliseconds 0 + millisecondsPerMinute / 2) / millisecondsPerMinute)

def numberOf (line : WaitLine) (seconds minutes : Int) : Int :=
  if line = .countdown then seconds else if line = .longer then minutes else 0

def nominalIdentify (rows : Int) : Int := rows * identifyPerKiloRowMs / rowsPerKilo

def scaledIdentify (rows elapsed gained : Int) : Int :=
  rows * identifyPerKiloRowMs * elapsed / (gained * preparePerKiloRowMs)

def track (s : Wait) (now stage done total rows : Int) : Wait :=
  if stage ≠ s.stage ∨ total ≠ s.total then
    { s with now := now, stage := stage, total := total, baseAt := now, baseDone := done,
             lastDone := done, progressAt := now,
             identifyEnd :=
               if stage = lastStage ∧ s.stage ≠ lastStage then
                 now + (if s.identifyBudget > 0 then s.identifyBudget else nominalIdentify rows)
               else s.identifyEnd }
  else if done > s.lastDone then
    { s with now := now,
             baseAt := if s.line = .weakSignal then now else s.baseAt,
             baseDone := if s.line = .weakSignal then done else s.baseDone,
             lastDone := done, progressAt := now }
  else { s with now := now }

def remaining (t : Wait) (now total rows : Int) : Int :=
  let elapsed := t.progressAt - t.baseAt
  let gained := t.lastDone - t.baseDone
  if t.stage = lastStage then max (t.identifyEnd - now) 0
  else if elapsed < firstEstimateMs ∨ gained ≤ 0 ∨ total ≤ 0 then -1
  else
    let left := max (total - t.lastDone) 0 * elapsed / gained
    let idle := now - t.progressAt
    if t.stage = 0 then
      max (left + rows * (preparePerKiloRowMs + identifyPerKiloRowMs) / rowsPerKilo - idle) 0
    else max (left + scaledIdentify total elapsed gained - idle) 0

def refine (s t : Wait) (now left : Int) : Wait :=
  let budgeted :=
    if t.stage = 1 ∧ left ≥ 0 then
      { t with
        identifyBudget := scaledIdentify t.total (t.progressAt - t.baseAt) (t.lastDone - t.baseDone) }
    else t
  let predicted :=
    if s.line = .measuring ∧ s.changedAt = 0 ∧ s.fast = false ∧ left ≥ 0 ∧ now + left ≤ fastRunMs
    then { budgeted with fast := true }
    else budgeted
  if predicted.fast = true ∧ now > fastLimitMs then { predicted with fast := false } else predicted

def advance (s t : Wait) (now stage : Int) : Wait :=
  if t.fast = false ∧ s.shown < stage ∧ now - s.shownAt ≥ stepHoldMs then
    { t with shown := s.shown + 1, shownAt := now }
  else t

def choose (s t : Wait) (now left stage : Int) : WaitChoice :=
  let keep : WaitChoice := ⟨s.line, s.seconds, s.minutes, t.deadline, t.stableSince⟩
  if stage = 0 ∧ now - t.progressAt ≥ stallMs then
    ⟨.weakSignal, s.seconds, s.minutes, t.deadline, -1⟩
  else if s.line = .almostDone then keep
  else if left < 0 then
    if s.line = .countdown then
      let next := min s.seconds (ceilSeconds (t.deadline - now))
      ⟨if next ≤ almostSeconds then .almostDone else .countdown, next, s.minutes, t.deadline, -1⟩
    else if s.line = .weakSignal then ⟨.measuring, s.seconds, s.minutes, t.deadline, -1⟩
    else keep
  else if left ≤ almostMs then ⟨.almostDone, s.seconds, s.minutes, t.deadline, -1⟩
  else
    let short := decide (left ≤ shortMs ∧ ceilSeconds left ≤ s.seconds)
    if s.line = .countdown then
      if now + left - slackMs > t.deadline ∨ left > shortMs then
        ⟨.longer, s.seconds, coarseMinutes left, t.deadline, -1⟩
      else
        let deadline := min t.deadline (now + left)
        let next := min s.seconds (ceilSeconds (deadline - now))
        ⟨if next ≤ almostSeconds then .almostDone else .countdown, next, s.minutes, deadline, -1⟩
    else if s.line = .longer ∧ short = false then
      ⟨.longer, s.seconds,
        if now - s.changedAt ≥ minuteHoldMs then coarseMinutes left else s.minutes,
        t.deadline, -1⟩
    else if s.line = .longer ∧ (t.stableSince < 0 ∨ now - t.stableSince < stableMs) then
      ⟨.longer, s.seconds, s.minutes, t.deadline,
        if t.stableSince < 0 then now else t.stableSince⟩
    else if short = true then ⟨.countdown, ceilSeconds left, s.minutes, now + left, -1⟩
    else ⟨.longer, s.seconds, coarseMinutes left, t.deadline, -1⟩

def step (s : Wait) (input : WaitInput) : Wait :=
  let now := clamp input.now 0 maximumMilliseconds
  if s.finished = true ∨ now < s.now then s
  else
    let total := clamp input.total 0 maximumCount
    let done := clamp input.done 0 total
    let rows := clamp input.rows 0 maximumCount
    let stage := clamp input.stage 0 lastStage
    let tracked := track s now stage done total rows
    let left := remaining tracked now total rows
    let refined := refine s tracked now left
    if input.complete = true then
      { refined with
        finished := decide (refined.fast = true ∨ now ≤ fastRunMs ∨ now - s.shownAt ≥ stepHoldMs) }
    else
      let r := advance s refined now stage
      if r.fast = true ∨ now - s.changedAt < lineHoldMs then r
      else
        let c := choose s r now left stage
        let visible := decide (c.line ≠ s.line ∨
          numberOf c.line c.seconds c.minutes ≠ numberOf s.line s.seconds s.minutes)
        { r with line := c.line, seconds := c.seconds, minutes := c.minutes,
                 deadline := c.deadline, stableSince := c.stableSince,
                 changedAt := if visible = true then now else r.changedAt }

def run : Wait → List WaitInput → Wait
  | s, [] => s
  | s, input :: rest => run (step s input) rest

/-- What the screen draws from a display, which the Swift contract traces record. -/
structure WaitView where
  line : WaitLine
  number : Int
  changedAt : Int
  shown : Int
  finished : Bool
  fast : Bool
deriving DecidableEq

def Wait.view (s : Wait) : WaitView :=
  ⟨s.line, numberOf s.line s.seconds s.minutes, s.changedAt, s.shown, s.finished, s.fast⟩

def views : Wait → List WaitInput → List WaitView
  | _, [] => []
  | s, input :: rest => (step s input).view :: views (step s input) rest

/-- A countdown shows one second or more, and coarse minutes show one minute or more. -/
def Shows (s : Wait) : Prop :=
  (s.line = .countdown → s.seconds ≥ 1) ∧ s.minutes ≥ 1

section Bookkeeping

variable (s t : Wait) (now stage done total rows left : Int)

theorem track_keeps :
    (track s now stage done total rows).line = s.line ∧
    (track s now stage done total rows).seconds = s.seconds ∧
    (track s now stage done total rows).minutes = s.minutes ∧
    (track s now stage done total rows).changedAt = s.changedAt ∧
    (track s now stage done total rows).shown = s.shown ∧
    (track s now stage done total rows).shownAt = s.shownAt ∧
    (track s now stage done total rows).finished = s.finished := by
  unfold track
  split
  · simp
  · split <;> simp

theorem refine_keeps :
    (refine s t now left).line = t.line ∧
    (refine s t now left).seconds = t.seconds ∧
    (refine s t now left).minutes = t.minutes ∧
    (refine s t now left).changedAt = t.changedAt ∧
    (refine s t now left).shown = t.shown ∧
    (refine s t now left).shownAt = t.shownAt ∧
    (refine s t now left).finished = t.finished := by
  unfold refine
  simp only
  split <;> split <;> split <;> simp_all

theorem advance_keeps :
    (advance s t now stage).line = t.line ∧
    (advance s t now stage).seconds = t.seconds ∧
    (advance s t now stage).minutes = t.minutes ∧
    (advance s t now stage).changedAt = t.changedAt ∧
    (advance s t now stage).finished = t.finished ∧
    (advance s t now stage).fast = t.fast := by
  unfold advance
  split <;> simp

theorem advance_shown :
    (advance s t now stage).shown = t.shown ∨
      ((advance s t now stage).shown = s.shown + 1 ∧ now - s.shownAt ≥ 600) := by
  unfold advance
  split
  · rename_i h
    unfold stepHoldMs at h
    exact Or.inr ⟨rfl, h.2.2⟩
  · exact Or.inl rfl

theorem choose_seconds_le : (choose s t now left stage).seconds ≤ s.seconds := by
  unfold choose
  simp only
  repeat' split
  all_goals simp_all <;> omega

theorem choose_shows : Shows s →
    ((choose s t now left stage).line = .countdown → (choose s t now left stage).seconds ≥ 1) ∧
    (choose s t now left stage).minutes ≥ 1 := by
  intro h
  unfold Shows at *
  unfold choose ceilSeconds coarseMinutes almostSeconds almostMs millisecondsPerSecond
    millisecondsPerMinute at *
  simp only at *
  repeat' split
  all_goals simp_all <;> omega

theorem choose_almost : s.line = .almostDone →
    (choose s t now left stage).line = .almostDone ∨
      (choose s t now left stage).line = .weakSignal := by
  intro h
  unfold choose
  by_cases hStall : stage = 0 ∧ now - t.progressAt ≥ stallMs <;> simp [h, hStall]

end Bookkeeping

/-- Names the clamped inputs and every intermediate display of `step`, with what each function keeps. -/
syntax "open_step " term:max term:max : tactic

set_option hygiene false in
macro_rules
  | `(tactic| open_step $s $input) => `(tactic| (
      unfold step at *
      simp only at *
      generalize clamp ($input).now 0 maximumMilliseconds = now at *
      generalize clamp ($input).stage 0 lastStage = stage at *
      generalize clamp ($input).rows 0 maximumCount = rows at *
      generalize clamp ($input).total 0 maximumCount = total at *
      generalize clamp ($input).done 0 total = done at *
      have kt := track_keeps $s now stage done total rows
      generalize track $s now stage done total rows = tracked at *
      generalize remaining tracked now total rows = left at *
      have kr := refine_keeps $s tracked now left
      generalize refine $s tracked now left = refined at *
      have ka := advance_keeps $s refined now stage
      have kn := advance_shown $s refined now stage
      generalize advance $s refined now stage = r at *
      have kc := choose_seconds_le $s r now stage left
      have ks := choose_shows $s r now stage left
      have kd := choose_almost $s r now stage left
      generalize choose $s r now left stage = c at *))

/-- The countdown's seconds never rise after any one sample. -/
theorem countdownNeverRises (s : Wait) (input : WaitInput) :
    (step s input).seconds ≤ s.seconds := by
  open_step s input
  split
  · omega
  · split
    · simp_all
    · split
      · simp_all
      · simp only
        exact kc

/-- Along any finite trace of samples, a later countdown never shows more seconds than an earlier one. -/
theorem countdownNeverRisesAlongAnyTrace (s : Wait) (inputs : List WaitInput) :
    (run s inputs).seconds ≤ s.seconds := by
  induction inputs generalizing s with
  | nil => exact Int.le_refl _
  | cons input rest ih =>
    exact Int.le_trans (ih (step s input)) (countdownNeverRises s input)

/-- The line or its number changes only a full second after its previous change, and records that sample's time. -/
theorem lineChangesAtMostOncePerSecond (s : Wait) (input : WaitInput)
    (h : (step s input).line ≠ s.line ∨
      numberOf (step s input).line (step s input).seconds (step s input).minutes ≠
        numberOf s.line s.seconds s.minutes) :
    clamp input.now 0 maximumMilliseconds - s.changedAt ≥ 1000 ∧
      (step s input).changedAt = clamp input.now 0 maximumMilliseconds := by
  open_step s input
  by_cases h1 : s.finished = true ∨ now < s.now
  · simp [h1] at h
  · by_cases h2 : input.complete = true
    · simp [h1, h2] at h
      simp_all
    · by_cases h3 : r.fast = true ∨ now - s.changedAt < lineHoldMs
      · simp [h1, h2, h3] at h
        simp_all
      · rw [ite_eq_right h1, ite_eq_right h2, ite_eq_right h3] at h ⊢
        simp only at h ⊢
        refine ⟨by unfold lineHoldMs at h3; omega, ?_⟩
        have hv : decide (c.line ≠ s.line ∨
            numberOf c.line c.seconds c.minutes ≠ numberOf s.line s.seconds s.minutes) = true := by
          simpa using h
        rw [ite_eq_left hv]

/-- The time of the last change moves only when the line or its number changes, so it is always that change's time. -/
theorem changeTimeMovesOnlyWithTheLine (s : Wait) (input : WaitInput)
    (h : (step s input).changedAt ≠ s.changedAt) :
    (step s input).line ≠ s.line ∨
      numberOf (step s input).line (step s input).seconds (step s input).minutes ≠
        numberOf s.line s.seconds s.minutes := by
  open_step s input
  by_cases h1 : s.finished = true ∨ now < s.now
  · rw [ite_eq_left h1] at h
    exact absurd rfl h
  · by_cases h2 : input.complete = true
    · rw [ite_eq_right h1, ite_eq_left h2] at h
      simp_all
    · by_cases h3 : r.fast = true ∨ now - s.changedAt < lineHoldMs
      · rw [ite_eq_right h1, ite_eq_right h2, ite_eq_left h3] at h
        simp_all
      · rw [ite_eq_right h1, ite_eq_right h2, ite_eq_right h3] at h ⊢
        simp only at h ⊢
        by_cases hv : decide (c.line ≠ s.line ∨
            numberOf c.line c.seconds c.minutes ≠ numberOf s.line s.seconds s.minutes) = true
        · simpa using hv
        · rw [ite_eq_right hv] at h
          simp_all

/-- Every sample keeps a countdown at one second or more and coarse minutes at one or more. -/
theorem stepKeepsNumbersAboveZero (s : Wait) (input : WaitInput) (h : Shows s) :
    Shows (step s input) := by
  open_step s input
  unfold Shows at *
  split
  · exact h
  · split
    · simp_all
    · split
      · simp_all
      · exact ks h

theorem initialShowsNoZero : Shows Wait.initial := by
  unfold Shows Wait.initial unshownSeconds
  decide

/-- No display that a run reaches counts down to zero or shows zero minutes. -/
theorem zeroNeverShowsBeforeCompletion (inputs : List WaitInput) :
    Shows (run Wait.initial inputs) := by
  suffices ∀ s, Shows s → Shows (run s inputs) from this _ initialShowsNoZero
  induction inputs with
  | nil => intro s h; exact h
  | cons input rest ih => intro s h; exact ih _ (stepKeepsNumbersAboveZero s input h)

/-- Once the line says the run is almost done, it says so until the run ends, unless the transfer stalls. -/
theorem almostDoneStaysUntilTheEnd (s : Wait) (input : WaitInput) (h : s.line = .almostDone) :
    (step s input).line = .almostDone ∨ (step s input).line = .weakSignal := by
  open_step s input
  split
  · exact Or.inl h
  · split
    · simp_all
    · split
      · simp_all
      · exact kd h

/-- The done state appears only once the work completes. -/
theorem doneOnlyAfterCompletion (s : Wait) (input : WaitInput)
    (h : (step s input).finished = true) : s.finished = true ∨ input.complete = true := by
  open_step s input
  by_cases h1 : s.finished = true ∨ now < s.now
  · simp [h1] at h
    exact Or.inl h
  · by_cases h2 : input.complete = true
    · exact Or.inr h2
    · by_cases h3 : r.fast = true ∨ now - s.changedAt < lineHoldMs
      · simp [h1, h2, h3] at h
        simp_all
      · simp [h1, h2, h3] at h
        simp_all

/-- The shown step moves one step forward, and only after it stayed for the step hold. -/
theorem stepsStayForTheirHold (s : Wait) (input : WaitInput)
    (h : (step s input).shown ≠ s.shown) :
    (step s input).shown = s.shown + 1 ∧
      clamp input.now 0 maximumMilliseconds - s.shownAt ≥ 600 := by
  open_step s input
  by_cases h1 : s.finished = true ∨ now < s.now
  · simp [h1] at h
  · by_cases h2 : input.complete = true
    · simp [h1, h2] at h
      simp_all
    · by_cases h3 : r.fast = true ∨ now - s.changedAt < lineHoldMs
      · rw [ite_eq_right h1, ite_eq_right h2, ite_eq_left h3] at h ⊢
        rcases kn with hSame | hMoved
        · simp_all
        · exact hMoved
      · rw [ite_eq_right h1, ite_eq_right h2, ite_eq_right h3] at h ⊢
        simp only at h ⊢
        rcases kn with hSame | hMoved
        · simp_all
        · exact hMoved

/-- A run that completes within the fast time shows the done state at once. -/
theorem aFastRunGoesStraightToDone (s : Wait) (input : WaitInput) (hOpen : s.finished = false)
    (hOrdered : clamp input.now 0 maximumMilliseconds ≥ s.now) (hComplete : input.complete = true)
    (hFast : clamp input.now 0 maximumMilliseconds ≤ 2000) :
    (step s input).finished = true := by
  open_step s input
  unfold fastRunMs
  have h1 : ¬(s.finished = true ∨ now < s.now) := by simp [hOpen]; omega
  simp [h1, hComplete, hFast]

/-- The largest products in the estimate stay within Int64 once the inputs clamp. -/
theorem estimateProductsFitInt64 (left elapsed : Int) (hLeft : 0 ≤ left ∧ left ≤ maximumCount)
    (hElapsed : 0 ≤ elapsed ∧ elapsed ≤ maximumMilliseconds) :
    0 ≤ left * identifyPerKiloRowMs * elapsed ∧
      left * identifyPerKiloRowMs * elapsed ≤ 9223372036854775807 ∧
      left * elapsed ≤ 9223372036854775807 := by
  unfold maximumCount maximumMilliseconds identifyPerKiloRowMs at *
  have h1 : left * 3 ≤ 268435456 * 3 := by omega
  have h2 : left * 3 * elapsed ≤ 268435456 * 3 * 2147483647 :=
    Int.mul_le_mul h1 hElapsed.2 hElapsed.1 (by omega)
  have h3 : left * elapsed ≤ 268435456 * 2147483647 :=
    Int.mul_le_mul hLeft.2 hElapsed.2 hElapsed.1 (by omega)
  have h4 : 0 ≤ left * 3 * elapsed := Int.mul_nonneg (by omega) hElapsed.1
  omega

#print axioms countdownNeverRises
#print axioms countdownNeverRisesAlongAnyTrace
#print axioms lineChangesAtMostOncePerSecond
#print axioms changeTimeMovesOnlyWithTheLine
#print axioms stepKeepsNumbersAboveZero
#print axioms zeroNeverShowsBeforeCompletion
#print axioms almostDoneStaysUntilTheEnd
#print axioms doneOnlyAfterCompletion
#print axioms stepsStayForTheirHold
#print axioms aFastRunGoesStraightToDone
#print axioms estimateProductsFitInt64

end Phonebook
