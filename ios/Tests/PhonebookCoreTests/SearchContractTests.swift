import Foundation
import Testing

@testable import PhonebookCore

/// The website's answers in `SearchContract.json`, which `tools/search-contract.ts` writes from the website's code.
private struct SearchContract: Decodable {
  struct Words: Decodable {
    let text: String
    let words: [String]
  }
  struct Rank: Decodable {
    let name: String
    let places: [String]
    let query: String
    let rank: Int
  }
  struct Telephone: Decodable {
    let text: String
    let number: String?
  }
  let words: [Words]
  let ranks: [Rank]
  let telephones: [Telephone]
}

/// A plain restatement of the folding and splitting rule with the Unicode White_Space list spelled out.
private enum Reference {
  static let whiteSpace: Set<UInt32> = [
    0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0x85, 0xA0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
    0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000,
  ]
  static let dashes: Set<UInt32> = [
    0x2D, 0x30FC, 0xFF70, 0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0xFE63, 0xFF0D,
  ]

  static func character(_ value: UInt32) -> Unicode.Scalar {
    var folded = value
    if (0x30A1...0x30F6).contains(folded) || folded == 0x30FD || folded == 0x30FE {
      folded -= 0x60
    }
    if folded == 0x3095 { return "か" }
    if folded == 0x3096 { return "け" }
    if dashes.contains(folded) { return "-" }
    let scalar = Unicode.Scalar(folded) ?? "\u{FFFD}"
    return kanji[scalar] ?? scalar
  }

  /// The kanji variants come from the generated table, which the website's regeneration check verifies.
  static let kanji: [Unicode.Scalar: Unicode.Scalar] = {
    Dictionary(uniqueKeysWithValues: SearchInput.kanjiVariants)
  }()

  static func words(_ text: String) -> [String] {
    var selected = String.UnicodeScalarView()
    for scalar in text.unicodeScalars
    where !(0xFE00...0xFE0F).contains(scalar.value) && !(0xE0100...0xE01EF).contains(scalar.value) {
      selected.append(scalar)
    }
    var folded = String.UnicodeScalarView()
    for scalar in String(selected).precomposedStringWithCompatibilityMapping.lowercased()
      .unicodeScalars
    {
      folded.append(character(scalar.value))
    }
    var words: [String] = []
    var current = String.UnicodeScalarView()
    for scalar in String(folded).precomposedStringWithCanonicalMapping.unicodeScalars {
      if whiteSpace.contains(scalar.value) {
        if !current.isEmpty { words.append(String(current)) }
        current = String.UnicodeScalarView()
      } else {
        current.append(scalar)
      }
    }
    if !current.isEmpty { words.append(String(current)) }
    return words
  }

  static func rank(name: String, places: [String], words: [String]) -> NameRank? {
    guard let single = words.first else { return nil }
    let form = Reference.words(name).joined(separator: " ")
    let forms = places.map { Reference.words($0).joined(separator: " ") }
    func holds(_ text: String, _ word: String) -> Bool {
      Array(text.unicodeScalars).firstRange(of: Array(word.unicodeScalars)) != nil
    }
    guard words.allSatisfy({ word in holds(form, word) || forms.contains { holds($0, word) } })
    else { return nil }
    if !words.allSatisfy({ holds(form, $0) }) { return .place }
    if words.count > 1 { return .substring }
    if form.unicodeScalars.elementsEqual(single.unicodeScalars) { return .exact }
    return form.unicodeScalars.starts(with: single.unicodeScalars) ? .prefix : .substring
  }
}

private func contract() throws -> SearchContract {
  let url = try #require(Bundle.module.url(forResource: "SearchContract", withExtension: "json"))
  return try JSONDecoder().decode(SearchContract.self, from: Data(contentsOf: url))
}

private func rank(name: String, places: [String], query: String) -> NameRank? {
  let words = SearchInput.words(query)
  let forms = places.map(SearchInput.searchForm)
  return SearchInput.rank(name: SearchInput.searchForm(name), words: words) { index in
    forms.contains { $0.utf8.firstRange(of: words[index].utf8) != nil }
  }
}

@Test func splitsAndRanksEveryContractCaseLikeTheWebsite() throws {
  let contract = try contract()
  #expect(contract.words.count > 400 && contract.ranks.count == 400)
  for item in contract.words {
    #expect(SearchInput.words(item.text) == item.words, "\(item.text.unicodeScalars.map(\.value))")
    #expect(Reference.words(item.text) == item.words)
  }
  for item in contract.ranks {
    let expected = item.rank < 0 ? nil : NameRank(rawValue: item.rank)
    #expect(
      rank(name: item.name, places: item.places, query: item.query) == expected, "\(item.query)")
    #expect(
      Reference.rank(name: item.name, places: item.places, words: Reference.words(item.query))
        == expected)
  }
}

@Test func readsEveryContractTelephoneLikeTheWebsite() throws {
  let contract = try contract()
  #expect(contract.telephones.count > 400)
  #expect(contract.telephones.contains { $0.number != nil })
  #expect(contract.telephones.contains { $0.number == nil })
  for item in contract.telephones {
    #expect(
      SearchInput.normalizedPhone(item.text) == item.number,
      "\(item.text.unicodeScalars.map(\.value))")
  }
}

@Test func foldsAndSplitsGeneratedTextLikeTheReference() {
  let alphabet = Array(
    "図書館市川中央ア ｱァヵヶケカかけゕゖトとーｰ-‐‑‒–—―−﹣－ヷヴゔヽヾゝゞAaＡａ1１ｶﾞガが\u{3099}\u{309B}\t\n\u{85}\u{A0}\u{1680}\u{2000}\u{2028}\u{202F}\u{205F}\u{3000}\u{200B}\u{FEFF}\u{FE00}\u{FE0F}\u{E0100}"
      .unicodeScalars)
  var generator = SplitMix(seed: 20_261_104)
  for _ in 0..<4000 {
    var text = String.UnicodeScalarView()
    for _ in 0..<Int(generator.next() % 17) {
      text.append(alphabet[Int(generator.next() % UInt64(alphabet.count))])
    }
    let typed = String(text)
    let words = SearchInput.words(typed)
    #expect(words == Reference.words(typed), "\(typed.unicodeScalars.map(\.value))")
    #expect(SearchInput.searchForm(SearchInput.searchForm(typed)) == SearchInput.searchForm(typed))
    #expect(
      words.allSatisfy {
        !$0.isEmpty && !$0.unicodeScalars.contains(where: \.properties.isWhitespace)
      })
  }
}

@Test func ranksEveryCountOfNamedAndPlacedWords() {
  for words in 1...SearchInput.maximumQueryWords {
    for named in 0...words {
      for placed in 0...(words - named) {
        for single in [NameRank.exact, .prefix, .substring] {
          let expected: NameRank? =
            named + placed < words ? nil : named < words ? .place : words == 1 ? single : .substring
          #expect(
            SearchInput.wordRank(words: words, named: named, placed: placed, nameRank: single)
              == expected)
        }
      }
    }
  }
}

@Test func matchesNamesRegionsAndCategoriesForTheOwnersQueries() {
  let ichikawa = ["千葉県", "市川市", "図書館"]
  #expect(rank(name: "市川市中央図書館", places: ichikawa, query: "市川 図書館") == .substring)
  #expect(rank(name: "中央図書館", places: ichikawa, query: "市川\u{3000}図書館") == .place)
  #expect(rank(name: "中央館", places: ichikawa, query: "千葉") == .place)
  #expect(rank(name: "中央館", places: ichikawa, query: "図書館") == .place)
  #expect(rank(name: "中央図書館", places: ["東京都", "千代田区", "図書館"], query: "市川 図書館") == nil)
  #expect(SearchInput.searchForm("市ヶ谷") == SearchInput.searchForm("市ケ谷"))
  #expect(SearchInput.searchForm("ｾﾝﾀｰ") == SearchInput.searchForm("せんた—"))
  #expect(SearchInput.normalizedPhone("03 3581 2331") == "+81335812331")
}

@Test func findsEitherFormOfAKanjiVariantFromTheOther() {
  let tokyo = ["東京都", "千代田区", "図書館"]
  #expect(rank(name: "山崎図書館", places: tokyo, query: "山\u{FA11}") == .prefix)
  #expect(rank(name: "山\u{FA11}図書館", places: tokyo, query: "山崎") == .prefix)
  #expect(rank(name: "高田医院", places: tokyo, query: "髙田") == .prefix)
  #expect(rank(name: "髙田医院", places: tokyo, query: "高田") == .prefix)
  for (old, standard) in [("澤田", "沢田"), ("渡邊", "渡辺"), ("齋藤", "斎藤"), ("國立", "国立")] {
    #expect(rank(name: old + "会館", places: tokyo, query: standard) == .prefix)
    #expect(rank(name: standard + "会館", places: tokyo, query: old) == .prefix)
  }
  #expect(SearchInput.searchForm("壹 濱 龜 辨") == "壱 浜 亀 弁")
  #expect(SearchInput.searchForm("邉") == "邉")
  #expect(SearchInput.searchForm("葛\u{E0100}") == SearchInput.searchForm("葛"))
  #expect(SearchInput.searchForm("辻\u{FE00}") == "辻")
  #expect(SearchInput.searchForm("か\u{FE0F}\u{3099}") == "が")
  #expect(SearchInput.searchForm("崎") != SearchInput.searchForm("埼"))
  let pairs = SearchInput.kanjiVariants
  #expect(pairs.count > 1000)
  #expect(pairs.count == KanjiVariants.pairs.split(separator: " ").count)
  for (variant, target) in pairs {
    let representative = String(target)
    #expect(SearchInput.searchForm(String(variant)) == representative)
    #expect(SearchInput.searchForm(representative) == representative)
  }
}

/// A small seeded generator, so a run repeats exactly.
private struct SplitMix {
  var state: UInt64
  init(seed: UInt64) { state = seed }
  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var value = state
    value = (value ^ (value >> 30)) &* 0xBF58_476D_1CE4_E5B9
    value = (value ^ (value >> 27)) &* 0x94D0_49BB_1331_11EB
    return value ^ (value >> 31)
  }
}
