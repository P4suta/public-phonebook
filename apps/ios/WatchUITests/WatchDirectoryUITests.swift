import XCTest

@MainActor
final class WatchDirectoryUITests: XCTestCase {
  override func tearDown() async throws {
    await MainActor.run {
      let app = XCUIApplication()
      if let run = testRun, run.totalFailureCount > 0, app.state == .runningForeground {
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = "failure-accessibility-tree"
        tree.lifetime = .keepAlways
        add(tree)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "failure"
        shot.lifetime = .keepAlways
        add(shot)
      }
      app.terminate()
    }
    try await super.tearDown()
  }

  func testSearchStartsWithALabeledEntry() throws {
    let app = XCUIApplication()
    app.launch()
    XCTAssertTrue(app.navigationBars["電話番号をさがす"].waitForExistence(timeout: 10))
    let search = app.textFields["watch-search"]
    XCTAssertTrue(search.waitForExistence(timeout: 10))
    XCTAssertTrue(search.isHittable)
    XCTAssertEqual(search.label, "施設の名前でさがす")
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "watch-search"
    shot.lifetime = .keepAlways
    add(shot)
    try app.performAccessibilityAudit()
    let about = app.buttons["watch-about"]
    for _ in 0..<8 where !about.isHittable { app.swipeUp() }
    XCTAssertTrue(about.isHittable)
    about.tap()
    let privacy = app.buttons["watch-privacy"]
    for _ in 0..<8 where !privacy.isHittable { app.swipeUp() }
    XCTAssertTrue(privacy.isHittable)
    try app.performAccessibilityAudit()
    privacy.tap()
    XCTAssertTrue(app.buttons["開く"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["開く"].isHittable)
    try app.performAccessibilityAudit()
    let cancel = app.buttons["閉じる"].firstMatch
    XCTAssertTrue(cancel.waitForExistence(timeout: 5))
    cancel.tap()
    XCTAssertTrue(privacy.isHittable)
  }

  func testPairedPhoneDirectorySearchAndSource() throws {
    let app = XCUIApplication()
    app.launch()
    enter("clinic", in: app)
    let facility = app.buttons["watch-facility"].firstMatch
    XCTAssertTrue(facility.waitForExistence(timeout: 30))
    try app.performAccessibilityAudit()
    facility.tap()
    XCTAssertTrue(app.staticTexts["watch-number"].firstMatch.waitForExistence(timeout: 10))
    let source = app.buttons["watch-source"]
    for _ in 0..<8 where !source.isHittable { app.swipeUp() }
    XCTAssertTrue(source.isHittable)
    try app.performAccessibilityAudit()
    source.tap()
    XCTAssertTrue(app.buttons["開く"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["開く"].isHittable)
    try app.performAccessibilityAudit()
    let cancel = app.buttons["閉じる"].firstMatch
    XCTAssertTrue(cancel.waitForExistence(timeout: 5))
    cancel.tap()
    let license = app.buttons["watch-license"]
    for _ in 0..<8 where !license.isHittable { app.swipeUp() }
    XCTAssertTrue(license.isHittable)
    license.tap()
    XCTAssertTrue(app.buttons["開く"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["開く"].isHittable)
    try app.performAccessibilityAudit()
    XCTAssertTrue(cancel.waitForExistence(timeout: 5))
    cancel.tap()
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "watch-facility-source"
    shot.lifetime = .keepAlways
    add(shot)
  }

  func testSampleCityScreenshots() throws {
    continueAfterFailure = false
    let app = XCUIApplication()
    app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
    app.launch()
    enter("みほん", in: app)
    let facility = app.buttons.matching(identifier: "watch-facility").matching(
      NSPredicate(format: "label CONTAINS %@", "みほん市民図書館")
    ).firstMatch
    XCTAssertTrue(facility.waitForExistence(timeout: 30))
    reveal(facility, in: app)
    capture(app, name: "sample-city-search")
    facility.tap()
    let number = app.staticTexts["watch-number"].firstMatch
    XCTAssertTrue(number.waitForExistence(timeout: 10))
    XCTAssertEqual(number.label, "0300000000")
    capture(app, name: "sample-city-contact")
    reveal(app.buttons["watch-source"], in: app)
    capture(app, name: "sample-city-source")
  }

  private func enter(_ query: String, in app: XCUIApplication) {
    let search = app.textFields["watch-search"]
    XCTAssertTrue(search.waitForExistence(timeout: 10))
    reveal(search, in: app)
    search.tap()
    let submit = app.buttons["Search"]
    if !submit.waitForExistence(timeout: 5) { search.tap() }
    XCTAssertTrue(submit.waitForExistence(timeout: 10))
    app.typeText(query)
    submit.tap()
  }

  private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
    let content = app.collectionViews.firstMatch
    XCTAssertTrue(content.waitForExistence(timeout: 10))
    var towardTop = false
    var seen = false
    for _ in 0..<16 {
      let bar = app.navigationBars.firstMatch
      let top = bar.exists ? bar.frame.maxY : content.frame.minY
      let visible = CGRect(
        x: content.frame.minX, y: top, width: content.frame.width, height: content.frame.maxY - top
      )
      if element.exists {
        seen = true
        let frame = element.frame
        if element.isHittable, visible.contains(frame) { return }
        towardTop = frame.minY < top
      } else if seen {
        towardTop.toggle()
      }
      let origin = content.coordinate(withNormalizedOffset: .zero)
      let start = origin.withOffset(
        CGVector(
          dx: visible.width / 2,
          dy: top - content.frame.minY + visible.height * (towardTop ? 0.45 : 0.7)))
      let end = origin.withOffset(
        CGVector(
          dx: visible.width / 2,
          dy: top - content.frame.minY + visible.height * (towardTop ? 0.7 : 0.45)))
      start.press(forDuration: 0.1, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.1)
    }
    XCTFail("The screenshot content must be fully visible")
  }

  private func capture(_ app: XCUIApplication, name: String) {
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = name
    shot.lifetime = .keepAlways
    add(shot)
  }
}
