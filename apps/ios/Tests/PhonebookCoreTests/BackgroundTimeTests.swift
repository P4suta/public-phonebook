import Testing

@testable import PhonebookCore

/// Checks every transition, and every trace of up to eight events, from the state where the background task begins.
/// The decision has three states and two events, so the transitions decide every longer trace too.
@Test func everyBackgroundTimeTransitionEndsTheTaskOnce() {
  for state in BackgroundTime.allCases {
    for event in BackgroundTimeEvent.allCases {
      let step = state.applying(event)
      #expect(step.end == (event == .finish && state != .ended), "\(state) \(event)")
      #expect(step.cancel == (event == .expire && state == .running), "\(state) \(event)")
      #expect(step.release == (event == .expire && state != .ended), "\(state) \(event)")
      #expect((step.next == .ended) == (state == .ended || event == .finish), "\(state) \(event)")
    }
  }
  var reached: Set<BackgroundTime> = [.running]
  for length in 0...8 {
    for bits in 0..<(1 << length) {
      let events = (0..<length).map {
        bits >> $0 & 1 == 1 ? BackgroundTimeEvent.finish : BackgroundTimeEvent.expire
      }
      var state = BackgroundTime.running
      var ends: [Int] = []
      var cancels: [Int] = []
      var releases: [Int] = []
      for (index, event) in events.enumerated() {
        let step = state.applying(event)
        if step.end { ends.append(index) }
        if step.cancel { cancels.append(index) }
        if step.release { releases.append(index) }
        state = step.next
        reached.insert(state)
      }
      let finish = events.firstIndex(of: .finish)
      let expiry = events.firstIndex(of: .expire)
      // Every expiry handler that runs while the task lasts releases the locks before it returns, in one step.
      #expect(
        releases
          == events.indices.filter { index in
            events[index] == .expire && finish.map { index < $0 } ?? true
          },
        "\(events)")
      // The task ends once, at the operation's first end, and never without it.
      #expect(ends == (finish.map { [$0] } ?? []), "\(events)")
      // The first expiry before the operation ends cancels it once, and nothing else cancels it.
      var expected: [Int] = []
      if let expiry, finish.map({ expiry < $0 }) ?? true { expected = [expiry] }
      #expect(cancels == expected, "\(events)")
    }
  }
  #expect(reached == Set(BackgroundTime.allCases))
}
