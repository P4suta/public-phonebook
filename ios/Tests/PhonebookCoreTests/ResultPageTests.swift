import PhonebookCore
import Testing

@Test func resultPagesStayWithinBoundsAtSignedExtremes() {
  #expect(ResultPage.end(shown: 0, total: 0) == 0)
  #expect(ResultPage.end(shown: 0, total: 21) == 20)
  #expect(ResultPage.end(shown: 20, total: 21) == 21)
  #expect(ResultPage.end(shown: Int.max - 1, total: Int.max) == Int.max)
  #expect(ResultPage.end(shown: Int.min, total: Int.max) == 0)
  #expect(ResultPage.end(shown: Int.max, total: Int.min) == 0)
  for total in [0, 1, 19, 20, 21, 100, 4096, Int.max] {
    for shown in Set([0, total / 2, max(0, total - 1), total]) {
      let end = ResultPage.end(shown: shown, total: total)
      #expect((shown...total).contains(end))
      #expect(end - shown <= 20)
      #expect(end > shown || shown == total)
    }
  }
}
