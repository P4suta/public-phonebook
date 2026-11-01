import XCTest

@MainActor
final class DirectoryUITests: XCTestCase {
  private var service: ServiceFixture?

  override func setUp() async throws {
    try await super.setUp()
    let fixture = try await ServiceFixture()
    await MainActor.run { service = fixture }
  }

  override func tearDown() async throws {
    await MainActor.run {
      let app = XCUIApplication()
      if let run = testRun, run.totalFailureCount > 0, app.state == .runningForeground {
        capture(app, name: "failure")
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "failure-accessibility-tree"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
      }
      XCUIDevice.shared.orientation = .portrait
      app.terminate()
      service = nil
    }
    try await super.tearDown()
  }

  func testOnboardingSavesTheDirectoryBeforeSearch() throws {
    let app = application()
    app.launch()
    let start = app.buttons["onboarding-start"]
    XCTAssertTrue(start.waitForExistence(timeout: 15))
    capture(app, name: "onboarding-welcome")
    start.tap()
    XCTAssertTrue(app.buttons["onboarding-caller"].waitForExistence(timeout: 10))
    capture(app, name: "onboarding-caller")
    app.buttons["onboarding-later"].tap()
    let finish = app.buttons["onboarding-finish"]
    XCTAssertTrue(finish.waitForExistence(timeout: 10))
    waitUntil(finish.isEnabled, timeout: 60)
    capture(app, name: "onboarding-ready")
    finish.tap()
    XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 10))
    XCTAssertTrue(app.descendants(matching: .any)["search-hint"].exists)
    XCTAssertFalse(app.staticTexts["directory-total"].exists)
    XCTAssertEqual(try proxy().requests.filter { $0.hasPrefix("/api/v1/datasets/") }.count, 1)
    capture(app, name: "initial-search")
  }

  func testSearchGroupsResultsAndShowsMore() throws {
    let app = prepared()
    search("facility", in: app)
    waitForLabel(app.staticTexts["directory-total"], "239件 見つかりました")
    let hidden = app.buttons["Index facility 003の情報を見る"]
    XCTAssertFalse(hidden.exists)
    let more = app.buttons["more-library"]
    reveal(more, in: app)
    capture(app, name: "grouped-results")
    let requests = try proxy().requests.count
    more.tap()
    waitUntil(!more.exists, timeout: 10)
    reveal(hidden, in: app)
    XCTAssertEqual(try proxy().requests.count, requests)
  }

  func testTelephoneSearchFindsEveryRecordForTheNumber() throws {
    let app = prepared()
    search("03-0000-0000", in: app)
    waitForLabel(app.staticTexts["directory-total"], "241件 見つかりました")
    search("０３（００００）００００", in: app)
    waitForLabel(app.staticTexts["directory-total"], "241件 見つかりました")
  }

  func testEmptyResultsAndLargeText() throws {
    let app = prepared(textSize: "UICTContentSizeCategoryAccessibilityXXXL")
    search("No matching facility 123456789", in: app)
    let empty = app.staticTexts["施設や窓口が見つかりませんでした"]
    XCTAssertTrue(empty.waitForExistence(timeout: 15))
    reveal(app.staticTexts["名前の一部だけを入れてみてください。"], in: app)
    try app.performAccessibilityAudit()
    capture(app, name: "empty-large-text")
  }

  func testContactDetailShowsRegionSourceAndExternalLinkConfirmation() throws {
    let app = prepared()
    search("試験", in: app)
    waitForLabel(app.staticTexts["directory-total"], "1件 見つかりました")
    XCTAssertEqual(app.staticTexts["contact-region"].label, "Test prefecture 13Test city 13")
    let detail = app.buttons["contact-detail"].firstMatch
    detail.tap()
    XCTAssertTrue(app.navigationBars["施設の情報"].waitForExistence(timeout: 10))
    let address = app.buttons["address-link"]
    reveal(address, in: app)
    address.tap()
    let alert = app.alerts["ほかのサイトを開きます"]
    XCTAssertTrue(alert.waitForExistence(timeout: 5))
    XCTAssertTrue(
      alert.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "行き先：www.google.com"))
        .firstMatch.exists)
    capture(app, name: "external-link-confirmation")
    alert.buttons["やめる"].tap()
    XCTAssertTrue(alert.waitForNonExistence(timeout: 5))
    XCTAssertEqual(app.state, .runningForeground)
    let source = app.buttons["source-link"]
    reveal(source, in: app)
    let requests = try proxy().requests.count
    source.tap()
    XCTAssertTrue(app.navigationBars["電話番号のもとの情報"].waitForExistence(timeout: 10))
    let license = app.staticTexts["source-license"]
    XCTAssertTrue(license.waitForExistence(timeout: 5))
    XCTAssertTrue(license.label.hasPrefix("使うときの決まり："))
    reveal(app.buttons["もとの資料を開く"], in: app)
    XCTAssertEqual(try proxy().requests.count, requests)
    capture(app, name: "source")
  }

  func testPhoneNumberCopyShowsFeedback() throws {
    let app = prepared()
    search("試験", in: app)
    let copy = app.buttons["phone-copy"].firstMatch
    XCTAssertTrue(copy.waitForExistence(timeout: 15))
    XCTAssertTrue(copy.label.contains("コピーする"))
    copy.tap()
    let feedback = app.staticTexts["copy-feedback"]
    XCTAssertTrue(feedback.waitForExistence(timeout: 5))
    XCTAssertEqual(feedback.label, "電話番号をコピーしました。")
  }

  func testPortraitLandscapeRoundTrip() throws {
    let app = prepared()
    XCUIDevice.shared.orientation = .landscapeLeft
    waitUntil(app.windows.firstMatch.frame.width > app.windows.firstMatch.frame.height)
    capture(app, name: "landscape-before-search")
    search("試験", in: app)
    app.buttons["contact-detail"].firstMatch.tap()
    XCTAssertTrue(app.navigationBars["施設の情報"].waitForExistence(timeout: 10))
    capture(app, name: "landscape-detail")
    XCUIDevice.shared.orientation = .portrait
    waitUntil(app.windows.firstMatch.frame.width < app.windows.firstMatch.frame.height)
    reveal(app.buttons["source-link"], in: app)
    capture(app, name: "portrait-detail-after-rotation")
  }

  func testBackgroundForegroundPreservesSearchAndDetail() throws {
    let app = prepared()
    search("試験", in: app)
    app.buttons["contact-detail"].firstMatch.tap()
    XCTAssertTrue(app.navigationBars["施設の情報"].waitForExistence(timeout: 10))
    XCUIDevice.shared.press(.home)
    XCTAssertTrue(app.wait(for: .runningBackground, timeout: 10))
    app.activate()
    XCTAssertTrue(app.navigationBars["施設の情報"].waitForExistence(timeout: 10))
    goBack(app)
    waitForLabel(app.staticTexts["directory-total"], "1件 見つかりました")
  }

  func testDirectoryFailureShowsRetryAndRecovers() throws {
    let app = application()
    try proxy().failNext(.dataset)
    app.launch()
    let start = app.buttons["onboarding-start"]
    XCTAssertTrue(start.waitForExistence(timeout: 15))
    start.tap()
    let problem = app.staticTexts["sync-error"]
    XCTAssertTrue(problem.waitForExistence(timeout: 20))
    capture(app, name: "directory-failure")
    app.buttons["sync-retry"].tap()
    app.buttons["onboarding-later"].tap()
    let finish = app.buttons["onboarding-finish"]
    XCTAssertTrue(finish.waitForExistence(timeout: 10))
    waitUntil(finish.isEnabled, timeout: 60)
    XCTAssertFalse(problem.exists)
    XCTAssertEqual(try proxy().injected, 1)
  }

  func testUpdateCancellationKeepsTheSavedDirectory() throws {
    let app = prepared()
    openSettings(in: app)
    let saved = app.staticTexts["saved-date"]
    let label = saved.label
    try proxy().failNext(.dataset, with: .incomplete)
    let update = app.buttons["update-now"]
    reveal(update, in: app)
    update.tap()
    let cancel = app.buttons["保存をやめる"]
    XCTAssertTrue(cancel.waitForExistence(timeout: 15))
    XCTAssertTrue(app.descendants(matching: .any)["sync-progress"].exists)
    capture(app, name: "directory-downloading")
    cancel.tap()
    waitUntil(!app.descendants(matching: .any)["sync-progress"].exists, timeout: 15)
    XCTAssertEqual(saved.label, label)
    app.terminate()
    app.launch()
    search("試験", in: app)
    waitForLabel(app.staticTexts["directory-total"], "1件 見つかりました")
  }

  func testLandscapeLargeTextSettings() throws {
    let app = prepared(textSize: "UICTContentSizeCategoryAccessibilityXXXL")
    XCUIDevice.shared.orientation = .landscapeLeft
    openSettings(in: app)
    reveal(app.buttons["update-now"], in: app)
    try app.performAccessibilityAudit()
    capture(app, name: "landscape-large-settings")
  }

  func testAboutStaysInTheAppAndLicenseIsReadable() throws {
    let app = prepared()
    let menu = app.buttons["メニュー"]
    XCTAssertTrue(menu.waitForExistence(timeout: 15))
    menu.tap()
    app.buttons["Public Phonebookについて"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["about-content"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["プライバシー"].waitForExistence(timeout: 5))
    capture(app, name: "about")
    let sources = app.buttons["sources-link"]
    reveal(sources, in: app)
    sources.tap()
    XCTAssertTrue(app.navigationBars["データの出典"].waitForExistence(timeout: 5))
    goBack(app)
    let license = app.buttons["license-link"]
    reveal(license, in: app)
    license.tap()
    XCTAssertTrue(app.navigationBars["ライセンス"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.state, .runningForeground)
    capture(app, name: "license")
  }

  func testLivePublicDirectorySearchAndSource() throws {
    let app = application()
    app.launchEnvironment.removeValue(forKey: "PHONEBOOK_API_ORIGIN")
    app.launch()
    onboard(app, timeout: 300)
    search("図書館", in: app)
    XCTAssertTrue(app.staticTexts["directory-total"].waitForExistence(timeout: 30))
    let detail = app.buttons["contact-detail"].firstMatch
    XCTAssertTrue(detail.waitForExistence(timeout: 10))
    capture(app, name: "live-public-directory-search")
    detail.tap()
    let source = app.buttons["source-link"]
    reveal(source, in: app)
    source.tap()
    XCTAssertTrue(app.staticTexts["source-license"].waitForExistence(timeout: 10))
    capture(app, name: "live-public-directory-source")
  }

  private func application(textSize: String = "UICTContentSizeCategoryL") -> XCUIApplication {
    continueAfterFailure = false
    XCUIDevice.shared.orientation = .portrait
    let app = XCUIApplication()
    app.launchEnvironment["PHONEBOOK_API_ORIGIN"] = service?.origin ?? "http://localhost:3100"
    app.launchArguments = [
      "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
      "-UIPreferredContentSizeCategoryName", textSize,
    ]
    return app
  }

  /// Launches the app and completes the first-run steps when they appear.
  private func prepared(textSize: String = "UICTContentSizeCategoryL") -> XCUIApplication {
    let app = application(textSize: textSize)
    app.launch()
    onboard(app)
    return app
  }

  private func onboard(_ app: XCUIApplication, timeout: TimeInterval = 60) {
    let field = app.searchFields.firstMatch
    let start = app.buttons["onboarding-start"]
    waitUntil(field.exists || start.exists, timeout: 15)
    guard start.exists else { return }
    start.tap()
    let later = app.buttons["onboarding-later"]
    XCTAssertTrue(later.waitForExistence(timeout: 10))
    later.tap()
    let finish = app.buttons["onboarding-finish"]
    XCTAssertTrue(finish.waitForExistence(timeout: 10))
    waitUntil(finish.isEnabled, timeout: timeout)
    finish.tap()
    XCTAssertTrue(field.waitForExistence(timeout: 10))
  }

  private func goBack(_ app: XCUIApplication) {
    let back = app.buttons["BackButton"].firstMatch
    XCTAssertTrue(back.waitForExistence(timeout: 5))
    back.tap()
  }

  private func capture(_ app: XCUIApplication, name: String) {
    let shot = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
    shot.name = name
    shot.lifetime = .keepAlways
    add(shot)
  }

  private func proxy() throws -> ServiceFixture {
    try XCTUnwrap(service)
  }

  private func search(_ text: String, in app: XCUIApplication) {
    let field = app.searchFields.firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 15))
    field.tap()
    if let current = field.value as? String, !current.isEmpty,
      current != field.placeholderValue
    {
      field.buttons.firstMatch.tap()
    }
    field.typeText(text + "\n")
  }

  private func openSettings(in app: XCUIApplication) {
    let menu = app.buttons["メニュー"]
    XCTAssertTrue(menu.waitForExistence(timeout: 15))
    menu.tap()
    let settings = app.buttons["設定"]
    XCTAssertTrue(settings.waitForExistence(timeout: 5))
    settings.tap()
    XCTAssertTrue(app.navigationBars["設定"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["saved-date"].waitForExistence(timeout: 10))
  }

  private func waitUntil(
    _ condition: @autoclosure @escaping () -> Bool, timeout: TimeInterval = 10
  ) {
    let expected = XCTNSPredicateExpectation(
      predicate: NSPredicate { _, _ in MainActor.assumeIsolated { condition() } }, object: nil)
    XCTAssertEqual(XCTWaiter.wait(for: [expected], timeout: timeout), .completed)
  }

  private func waitForLabel(_ element: XCUIElement, _ label: String, timeout: TimeInterval = 15) {
    waitUntil(element.exists && element.label == label, timeout: timeout)
  }

  private func reveal(
    _ element: XCUIElement, in app: XCUIApplication, swipes: Int = 16, towardTop: Bool = false
  ) {
    for _ in 0..<swipes {
      var scrollDown = towardTop
      if element.exists {
        let frame = element.frame
        let center = CGPoint(x: frame.midX, y: frame.midY)
        if element.isHittable && app.windows.firstMatch.frame.contains(center) { return }
        let top =
          app.navigationBars.firstMatch.exists ? app.navigationBars.firstMatch.frame.maxY : 0
        if frame.midY < top { scrollDown = true }
        if frame.midY > app.windows.firstMatch.frame.maxY { scrollDown = false }
      }
      let window = app.windows.firstMatch
      let start = window.coordinate(
        withNormalizedOffset: CGVector(dx: 0.5, dy: scrollDown ? 0.45 : 0.7))
      let end = window.coordinate(
        withNormalizedOffset: CGVector(dx: 0.5, dy: scrollDown ? 0.7 : 0.45))
      start.press(forDuration: 0.01, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.1)
    }
    XCTAssertTrue(element.isHittable)
  }
}
