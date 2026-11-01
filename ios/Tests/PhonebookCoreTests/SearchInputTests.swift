import Foundation
import Testing

@testable import PhonebookCore

private let phoneTable: [(text: String, phone: String?)] = [
  ("", nil), ("   ", nil), ("図書館", nil), ("library", nil),
  ("03-1234-5678", "+81312345678"), ("０３－１２３４－５６７８", "+81312345678"),
  ("(03) 1234 5678", "+81312345678"), ("+81 3 1234 5678", "+81312345678"),
  ("＋８１３１２３４５６７８", "+81312345678"), ("090-1234-5678", "+819012345678"),
  ("09012345678", "+819012345678"), ("0312345678", "+81312345678"), ("031234567", nil),
  ("031234567890", nil), ("0012345678", nil), ("+810312345678", nil),
  ("03ー1234ー5678", "+81312345678"), ("03ｰ1234ｰ5678", "+81312345678"),
  ("03.1234.5678", "+81312345678"), ("03−1234−5678", "+81312345678"),
  ("03⁻1234₋5678", "+81312345678"), ("03﹣1234﹣5678", "+81312345678"), ("110", nil),
  ("市役所 1", nil), ("\u{00a0}03-1234-5678\u{00a0}", "+81312345678"),
  (String(repeating: "0", count: 81), nil),
]

@Test func phoneQueriesMatchTheWebNormalizer() {
  for row in phoneTable {
    #expect(SearchInput.normalizedPhone(row.text) == row.phone, "\(row.text.debugDescription)")
  }
  let displays: [(String, String, String)] = [
    ("03-1234-5678", "+81312345678", "03-1234-5678"),
    ("(03)1234-5678", "+81312345678", "03-1234-5678"),
    ("０３（１２３４）５６７８", "+81312345678", "03-1234-5678"),
    ("+81 3 1234 5678", "+81312345678", "03-1234-5678"),
    ("0312345678", "+81312345678", "0312345678"),
    ("03-9999-9999", "+81312345678", "0312345678"),
    ("0120-123-456", "+81120123456", "0120-123-456"),
  ]
  for (display, e164, expected) in displays {
    #expect(SearchInput.nationalDisplay(display, e164: e164) == expected, "\(display)")
  }
}

@Test func nameQueriesUseTheWebNormalizationAndRanks() {
  let names: [(String, String)] = [
    ("  図書館　", "図書館"), ("ﾄｼｮｶﾝ", "トショカン"), ("ＡＢＣ Library", "abc library"),
    ("①丁目", "1丁目"), ("\u{3000}", ""),
  ]
  for (text, expected) in names { #expect(SearchInput.normalizedName(text) == expected) }
  #expect(SearchInput.rank(name: "図書館", query: "図書館") == .exact)
  #expect(SearchInput.rank(name: "図書館分室", query: "図書館") == .prefix)
  #expect(SearchInput.rank(name: "中央図書館", query: "図書館") == .substring)
  #expect(SearchInput.rank(name: "中央公民館", query: "図書館") == nil)
  #expect(SearchInput.rank(name: "中央図書館", query: "") == nil)
  #expect(NameRank.allCases.sorted() == [.exact, .prefix, .substring])
}
