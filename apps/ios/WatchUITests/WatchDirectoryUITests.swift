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
    let cancel = app.buttons["閉じる"].firstMatch
    XCTAssertTrue(cancel.waitForExistence(timeout: 5))
    cancel.tap()
    XCTAssertTrue(privacy.isHittable)
  }

  func testPairedPhoneDirectorySearchAndSource() throws {
    let app = XCUIApplication()
    app.launch()
    let search = app.textFields["watch-search"]
    XCTAssertTrue(search.waitForExistence(timeout: 10))
    search.tap()
    app.typeText("clinic")
    let submit = app.buttons["Search"]
    XCTAssertTrue(submit.waitForExistence(timeout: 5))
    submit.tap()
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
    let cancel = app.buttons["閉じる"].firstMatch
    XCTAssertTrue(cancel.waitForExistence(timeout: 5))
    cancel.tap()
    let license = app.buttons["watch-license"]
    for _ in 0..<8 where !license.isHittable { app.swipeUp() }
    XCTAssertTrue(license.isHittable)
    license.tap()
    XCTAssertTrue(app.buttons["開く"].waitForExistence(timeout: 5))
    XCTAssertTrue(cancel.waitForExistence(timeout: 5))
    cancel.tap()
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "watch-facility-source"
    shot.lifetime = .keepAlways
    add(shot)
  }
}
