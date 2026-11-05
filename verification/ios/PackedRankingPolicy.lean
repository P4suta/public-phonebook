import Lean.Elab.Tactic.Omega

namespace Phonebook

def packedFits (offset length size : Int) : Bool :=
  offset >= 0 && length >= 0 && size >= 0 && offset <= 268435456 &&
  length <= 268435456 && size <= 268435456 && offset <= size && length <= size - offset

def packedMidpoint (low high : Int) : Int :=
  if low >= 0 && low < high && high <= 268435456 then low + (high - low) / 2 else 0

def packedScratchSum (total increment : Int) : Int := total + increment

def packedReadingKey (row contacts frequency : Int) : Int := (6 - frequency) * contacts + row

theorem packedReadingBucketBounds (row contacts frequency : Int)
    (hc : 1 ≤ contacts ∧ contacts ≤ 2000000) (hr : 0 ≤ row ∧ row < contacts)
    (hf : 1 ≤ frequency ∧ frequency ≤ 6) :
    0 ≤ packedReadingKey row contacts frequency ∧ packedReadingKey row contacts frequency < 12000000 ∧
    packedReadingKey row contacts frequency % contacts = row ∧
    (6 - frequency) * contacts ≤ packedReadingKey row contacts frequency ∧
    packedReadingKey row contacts frequency < (7 - frequency) * contacts := by
  have remainder : packedReadingKey row contacts frequency % contacts = row := by
    simp [packedReadingKey, Int.add_emod, Int.mul_emod, Int.emod_eq_of_lt hr.1 hr.2]
  have alternatives : frequency = 1 ∨ frequency = 2 ∨ frequency = 3 ∨ frequency = 4 ∨ frequency = 5 ∨ frequency = 6 := by omega
  rcases alternatives with h | h | h | h | h | h <;> subst frequency <;>
    simp_all [packedReadingKey] <;> omega

theorem packedScratchFitsUInt32 (total increment : Int)
    (ht : 0 ≤ total ∧ total ≤ 25600000 - increment)
    (hi : 1 ≤ increment ∧ increment ≤ 25600000) :
    1 ≤ packedScratchSum total increment ∧ packedScratchSum total increment ≤ 25600000 ∧
    packedScratchSum total increment < 4294967296 := by simp [packedScratchSum]; omega

theorem packedBoundsEquivalent (offset length size : Int)
    (ho : 0 ≤ offset ∧ offset ≤ 268435456)
    (hl : 0 ≤ length ∧ length ≤ 268435456)
    (hs : 0 ≤ size ∧ size ≤ 268435456) :
    packedFits offset length size = true ↔ offset + length ≤ size := by
  simp [packedFits]
  omega

theorem packedMidpointProgress (low high : Int)
    (hl : 0 ≤ low) (hh : low < high ∧ high ≤ 268435456) :
    low ≤ packedMidpoint low high ∧ packedMidpoint low high < high := by
  simp [packedMidpoint, hl, hh.1, hh.2]
  omega

theorem packedArithmeticFitsInt64 (offset length size low high : Int)
    (ho : 0 ≤ offset ∧ offset ≤ 268435456)
    (hl : 0 ≤ length ∧ length ≤ 268435456)
    (hs : 0 ≤ size ∧ size ≤ 268435456)
    (hb : 0 ≤ low ∧ low < high ∧ high ≤ 268435456) :
    -9223372036854775808 ≤ size - offset ∧ size - offset ≤ 9223372036854775807 ∧
    0 ≤ offset + length + 3 ∧ offset + length + 3 ≤ 9223372036854775807 ∧
    0 ≤ high - low ∧ high - low ≤ 9223372036854775807 ∧
    0 ≤ low + (high - low) / 2 ∧ low + (high - low) / 2 ≤ 9223372036854775807 := by omega

#print axioms packedBoundsEquivalent
#print axioms packedMidpointProgress
#print axioms packedArithmeticFitsInt64
#print axioms packedScratchFitsUInt32
#print axioms packedReadingBucketBounds

end Phonebook
