import Lean.Elab.Tactic.Omega

namespace Phonebook

def rankDice (shared query name : Int) : Int :=
  if query + name = 0 then 0 else 20000 * shared / (query + name)

def rankMixed (bigram unigram : Int) : Int :=
  (bigram * 7 + unigram * 3) / 10 * 100

def rankReading (literal exactKana : Bool) (lexical kana : Int) : Int :=
  if literal then 1000000
  else if exactKana then 900000 + lexical * 9
  else lexical * 20 + kana * 60

def rankPreferred (score : Int) (preferred : Bool) : Int :=
  score * 499999 / 1000000 + if preferred then 500000 else 0

def rankSignal (score : Int) : Int :=
  if score = 1000000 then 999999 else score

def rankConservative (han : Bool) (lexical reading : Int) : Bool :=
  reading >= 900000 && lexical <= 600000 && (!han || reading > 900000)

def rankGate (ratio kana : Int) (alias conservative : Bool) : Bool :=
  alias || conservative || (ratio > 1250 && kana > 500)

theorem rankingDiceBound (shared query name : Int) (hs : 0 ≤ shared)
    (hq : shared ≤ query) (hn : shared ≤ name) :
    0 ≤ rankDice shared query name ∧ rankDice shared query name ≤ 10000 := by
  unfold rankDice
  split
  · omega
  · rename_i nonzero
    have positive : 0 < query + name := by omega
    constructor
    · exact Int.ediv_nonneg (by omega) (by omega)
    · apply Int.ediv_le_of_le_mul positive
      omega

theorem rankingMixtureBound (bigram unigram : Int)
    (hb : 0 ≤ bigram ∧ bigram ≤ 10000) (hu : 0 ≤ unigram ∧ unigram ≤ 10000) :
    0 ≤ rankMixed bigram unigram ∧ rankMixed bigram unigram ≤ 1000000 := by
  unfold rankMixed
  omega

theorem rankingReadingBands (literal exactKana : Bool) (lexical kana : Int)
    (hl : 0 ≤ lexical ∧ lexical ≤ 10000) (hk : 0 ≤ kana ∧ kana ≤ 10000) :
    0 ≤ rankReading literal exactKana lexical kana ∧
    rankReading literal exactKana lexical kana ≤ 1000000 ∧
    (literal = false → exactKana = false → rankReading literal exactKana lexical kana ≤ 800000) := by
  cases literal <;> cases exactKana <;> simp [rankReading] <;> omega

theorem rankingPreferenceBands (score : Int) (preferred : Bool) (h : 0 ≤ score ∧ score ≤ 1000000) :
    0 ≤ rankPreferred score preferred ∧ rankPreferred score preferred < 1000000 ∧
    (preferred = true → 500000 ≤ rankPreferred score preferred) ∧
    (preferred = false → rankPreferred score preferred < 500000) := by
  cases preferred <;> simp [rankPreferred] <;> omega

theorem rankingSignalProtectsExact (score : Int) (h : 0 ≤ score ∧ score ≤ 1000000) :
    0 ≤ rankSignal score ∧ rankSignal score < 1000000 := by
  unfold rankSignal
  split <;> omega

theorem rankingGateBoundaries :
    rankGate 1250 501 false false = false ∧ rankGate 1251 500 false false = false ∧
    rankGate 1251 501 false false = true := by decide

theorem rankingConservativeHanAnchor :
    rankConservative true 600000 900000 = false ∧
    rankConservative false 600000 900000 = true := by decide

theorem rankingArithmeticFitsInt64 (shared query name score bigram unigram : Int)
    (hs : 0 ≤ shared ∧ shared ≤ query) (hq : query ≤ 25600000)
    (hn : 0 ≤ name ∧ name ≤ 100000000000000) (hv : 0 ≤ score ∧ score ≤ 1000000)
    (hb : 0 ≤ bigram ∧ bigram ≤ 10000) (hu : 0 ≤ unigram ∧ unigram ≤ 10000) :
    0 ≤ 20000 * shared ∧ 20000 * shared ≤ 9223372036854775807 ∧
    0 ≤ query + name ∧ query + name ≤ 9223372036854775807 ∧
    0 ≤ score * 499999 ∧ score * 499999 ≤ 9223372036854775807 ∧
    0 ≤ bigram * 7 + unigram * 3 ∧ bigram * 7 + unigram * 3 ≤ 9223372036854775807 := by omega

#print axioms rankingDiceBound
#print axioms rankingMixtureBound
#print axioms rankingReadingBands
#print axioms rankingPreferenceBands
#print axioms rankingSignalProtectsExact
#print axioms rankingGateBoundaries
#print axioms rankingConservativeHanAnchor
#print axioms rankingArithmeticFitsInt64

end Phonebook
