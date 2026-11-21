import Vision
import XCTest

@MainActor
final class DirectoryUITests: XCTestCase {
  private var service: ServiceFixture?
  /// A proxy to the fixture's next revision, which lists a delta from the bundled baseline.
  private var updated: ServiceFixture?

  override func setUp() async throws {
    try await super.setUp()
    let fixture = try await ServiceFixture()
    let next = try await ServiceFixture(revision: .updated)
    await MainActor.run {
      service = fixture
      updated = next
    }
  }

  override func tearDown() async throws {
    await MainActor.run {
      let app = XCUIApplication()
      if let run = testRun, run.totalFailureCount > 0 {
        attach(service?.log ?? "The fixture wasn't running.", name: "fixture-requests")
        attach(updated?.log ?? "The fixture wasn't running.", name: "updated-fixture-requests")
        if app.state == .runningForeground {
          capture(app, name: "failure")
          attach(app.debugDescription, name: "failure-accessibility-tree")
        }
      }
      XCUIDevice.shared.orientation = .portrait
      app.terminate()
      service = nil
      updated = nil
    }
    try await super.tearDown()
  }

  /// A first run without a bundle downloads the complete archive before search.
  func testOnboardingSavesTheDirectoryBeforeSearch() throws {
    let app = application(bundled: .missing)
    app.launch()
    let start = app.buttons["onboarding-start"]
    XCTAssertTrue(start.waitForExistence(timeout: 15))
    let notice = app.descendants(matching: .any)["data-size-notice"]
    XCTAssertTrue(notice.waitForExistence(timeout: 5))
    // The notice shows the national archive's known size until the listing answers with the fixture's 2,303 bytes.
    waitUntil(
      "the notice shows the listed size",
      notice.exists && notice.label.contains("受け取るデータは約0.1MBです。"), timeout: 15,
      observed: { notice.exists ? "It shows “\(notice.label)”." : "It doesn't exist." })
    XCTAssertEqual(notice.label, "受け取るデータは約0.1MBです。")
    capture(app, name: "onboarding-welcome")
    XCTAssertEqual(try datasetFiles(), 0)
    start.tap()
    XCTAssertTrue(app.buttons["onboarding-caller"].waitForExistence(timeout: 10))
    capture(app, name: "onboarding-caller")
    app.buttons["onboarding-later"].tap()
    let finish = app.buttons["onboarding-finish"]
    XCTAssertTrue(finish.waitForExistence(timeout: 10))
    waitUntilSaved(finish, in: app, timeout: 60)
    XCTAssertTrue(app.staticTexts["準備ができました"].waitForExistence(timeout: 5))
    capture(app, name: "onboarding-ready")
    finish.tap()
    XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 10))
    XCTAssertTrue(app.descendants(matching: .any)["search-hint"].exists)
    XCTAssertTrue(app.staticTexts["施設名または電話番号を入力してください。"].exists)
    XCTAssertFalse(app.staticTexts["名前の一部でも、さがせます。"].exists)
    XCTAssertEqual(try proxy().requests.filter { $0.hasPrefix("/api/datasets/") }.count, 1)
    capture(app, name: "initial-search")
  }

  func testSearchGroupsRankedResultsAndShowsMore() throws {
    let app = prepared()
    search("とうきょう としょかん", in: app)
    waitForGroup("library", "件", in: app)
    capture(app, name: "reading-results")
    search("facility", in: app)
    waitForGroup("library", "件", in: app)
    XCTAssertFalse(app.staticTexts["search-limit"].exists)
    XCTAssertTrue(app.buttons["contact-detail"].firstMatch.label.contains("Test prefecture"))
    let more = app.buttons["more-library"]
    reveal(more, in: app)
    capture(app, name: "grouped-results")
    let names = app.buttons.matching(identifier: "contact-detail")
    let previous = Set(names.allElementsBoundByIndex.map(\.label))
    let requests = try proxy().requests.count
    more.tap()
    waitUntil(
      "the next library page appears",
      names.allElementsBoundByIndex.contains { !previous.contains($0.label) }, timeout: 10)
    XCTAssertEqual(try proxy().requests.count, requests)
  }

  func testSearchFieldShowsOneClearControl() throws {
    let app = prepared()
    let field = app.searchFields.firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 15))
    field.tap()
    field.typeText("試験")
    waitUntil(
      "the field holds the typed text", (field.value as? String) == "試験",
      observed: { "It holds “\(field.value as? String ?? "nothing")”." })
    XCTAssertEqual(field.placeholderValue, "施設名または電話番号")
    let clear = field.buttons.firstMatch
    XCTAssertTrue(clear.waitForExistence(timeout: 5))
    XCTAssertTrue(clear.isHittable)
    XCTAssertFalse(clear.label.isEmpty)
    try app.performAccessibilityAudit(for: .hitRegion)
    capture(app, name: "search-one-clear-control")
    clear.tap()
    waitUntil("the search is empty", field.value as? String == field.placeholderValue)
    XCTAssertTrue(app.descendants(matching: .any)["search-hint"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["施設名または電話番号を入力してください。"].exists)
    XCTAssertFalse(
      app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "読み仮名")).firstMatch.exists)
  }

  func testNativeBackGestureAndSettingsPreserveSearch() throws {
    let app = prepared()
    search("試験", in: app)
    let field = app.searchFields.firstMatch
    let detail = app.buttons["contact-detail"].firstMatch
    XCTAssertTrue(detail.waitForExistence(timeout: 10))
    detail.tap()
    XCTAssertTrue(app.navigationBars["施設の情報"].waitForExistence(timeout: 10))
    backGesture(in: app, distance: 0.12)
    XCTAssertTrue(app.navigationBars["施設の情報"].exists)
    reveal(app.buttons["source-link"], in: app)
    app.buttons["source-link"].tap()
    XCTAssertTrue(app.staticTexts["source-license"].waitForExistence(timeout: 10))
    backGesture(in: app)
    XCTAssertTrue(app.navigationBars["施設の情報"].waitForExistence(timeout: 10))
    backGesture(in: app)
    waitUntil("the back gesture reveals search", field.exists && field.isHittable, timeout: 5)
    XCTAssertEqual(field.value as? String, "試験")
    openSettings(in: app)
    app.buttons["Public Phonebookについて"].tap()
    XCTAssertTrue(app.navigationBars["Public Phonebookについて"].waitForExistence(timeout: 5))
    backGesture(in: app)
    app.buttons["close-settings"].tap()
    XCTAssertEqual(field.value as? String, "試験")
  }

  func testNativeBackGestureReturnsThroughSetupSteps() throws {
    let app = application()
    app.launchEnvironment["PHONEBOOK_CALLER_STATUS"] = "off"
    app.launch()
    let start = app.buttons["onboarding-start"]
    XCTAssertTrue(start.waitForExistence(timeout: 15))
    start.tap()
    let later = app.buttons["onboarding-later"]
    XCTAssertTrue(later.waitForExistence(timeout: 10))
    backGesture(in: app)
    XCTAssertTrue(start.waitForExistence(timeout: 5))
    start.tap()
    XCTAssertTrue(later.waitForExistence(timeout: 10))
    later.tap()
    let finish = app.buttons["onboarding-finish"]
    XCTAssertTrue(finish.waitForExistence(timeout: 10))
    backGesture(in: app)
    XCTAssertTrue(later.waitForExistence(timeout: 5))
  }

  private func backGesture(in app: XCUIApplication, distance: CGFloat = 0.85) {
    let window = app.windows.firstMatch
    let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0.005, dy: 0.5))
    let end = window.coordinate(withNormalizedOffset: CGVector(dx: distance, dy: 0.5))
    start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.2)
  }

  func testTelephoneSearchFindsEveryRecordForTheNumber() throws {
    let app = prepared()
    for query in ["03-0000-0000", "０３（００００）００００"] {
      search(query, in: app)
      // Every one of the 241 fixture records shares the number: 147 libraries, 47 clinics, and 47 dentists.
      waitForGroup("library", "147件", in: app)
      waitForGroup("medical", "47件", in: app)
      waitForGroup("dental", "47件", in: app)
      XCTAssertFalse(app.staticTexts["search-limit"].exists)
    }
  }

  func testClearingSearchFromDetailReturnsToTheInitialScreen() throws {
    let app = prepared()
    search("試験", in: app)
    app.buttons["contact-detail"].firstMatch.tap()
    XCTAssertTrue(app.navigationBars["施設の情報"].waitForExistence(timeout: 10))
    let clear = app.buttons["clear-search"]
    XCTAssertTrue(clear.waitForExistence(timeout: 5))
    XCTAssertTrue(clear.isHittable)
    XCTAssertEqual(clear.label, "検索を消す")
    capture(app, name: "detail-clear-search")
    clear.tap()
    let field = app.searchFields.firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    waitUntil("the search is empty", field.value as? String == field.placeholderValue)
    XCTAssertTrue(app.descendants(matching: .any)["search-hint"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.navigationBars["施設の情報"].exists)
    XCTAssertFalse(clear.exists)
    search("とうきょう としょかん", in: app)
    waitForGroup("library", "件", in: app)
    capture(app, name: "search-after-clearing-detail")
  }

  func testRankedMetadataRemainsReadableAtLargestTextSize() throws {
    let app = prepared(textSize: "UICTContentSizeCategoryAccessibilityXXXL")
    search("公開図書館", in: app)
    let heading = app.descendants(matching: .any)["group-library"]
    reveal(heading, in: app)
    XCTAssertTrue(heading.label.hasPrefix("図書館 "))
    let summary = app.buttons["contact-detail"].firstMatch
    reveal(summary, in: app)
    XCTAssertTrue(summary.label.contains("公開図書館"))
    XCTAssertTrue(summary.label.contains("Test prefecture 13Test city 13"))
    try auditVisibleContent(in: app)
    capture(app, name: "ranked-metadata-large-text")
  }

  func testEmptyResultsAndLargeText() throws {
    let app = prepared(textSize: "UICTContentSizeCategoryAccessibilityXXXL")
    search("zzzzzzzzzzzzzzzz", in: app)
    let empty = app.staticTexts["empty-results"]
    XCTAssertTrue(empty.waitForExistence(timeout: 15))
    XCTAssertEqual(empty.label, "あてはまる施設は0件です")
    reveal(app.staticTexts["別の言葉でさがしてください。"], in: app)
    try auditVisibleContent(in: app)
    capture(app, name: "empty-large-text")
  }

  func testContactDetailShowsRegionSourceAndExternalLinkConfirmation() throws {
    let app = application()
    app.launchArguments.append("--verify-unavailable-map")
    app.launch()
    onboard(app)
    search("試験", in: app)
    waitForGroup("dental", "1件", in: app)
    let name = "試験歯科 <script> & Test, clinic"
    let detail = app.buttons["contact-detail"].firstMatch
    XCTAssertTrue(detail.label.contains(name))
    XCTAssertTrue(detail.label.contains("Test prefecture 13Test city 13"))
    detail.tap()
    XCTAssertTrue(app.navigationBars["施設の情報"].waitForExistence(timeout: 10))
    let address = app.staticTexts["contact-address"]
    XCTAssertTrue(address.waitForExistence(timeout: 5))
    XCTAssertEqual(address.label, "Test, address; Suite 2\\東")
    XCTAssertFalse(app.buttons["contact-address"].exists)
    let map = app.buttons["map-button"]
    try auditVisibleContent(in: app, measuredList: "contact-content")
    reveal(map, in: app)
    XCTAssertEqual(map.label, "\(name)を地図で見る")
    capture(app, name: "contact-address")
    map.tap()
    let alert = app.alerts.firstMatch
    XCTAssertTrue(alert.waitForExistence(timeout: 5))
    XCTAssertTrue(
      alert.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Appleのマップ"))
        .firstMatch.exists)
    XCTAssertTrue(
      alert.staticTexts.matching(
        NSPredicate(format: "label CONTAINS %@", "施設の名前と住所をAppleのマップに送ります。")
      )
      .firstMatch.exists)
    capture(app, name: "external-link-confirmation")
    try auditModal(in: app, title: "地図を開きます", message: "施設の名前と住所をAppleのマップに送ります。")
    confirmationCancellation(in: app).tap()
    XCTAssertTrue(alert.waitForNonExistence(timeout: 5))
    XCTAssertEqual(app.state, .runningForeground)
    map.tap()
    alert.buttons["開く"].tap()
    let failure = app.descendants(matching: .any)["map-error"].firstMatch
    XCTAssertTrue(failure.waitForExistence(timeout: 5))
    XCTAssertTrue(failure.label.contains("場所を見つけられませんでした"))
    XCTAssertTrue(failure.label.contains("もう一度試してください"))
    reveal(map, in: app)
    map.tap()
    XCTAssertTrue(alert.waitForExistence(timeout: 5))
    confirmationCancellation(in: app).tap()
    XCTAssertTrue(alert.waitForNonExistence(timeout: 5))
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

  func testFacilityActionsChooseTheNumberWithoutNavigating() throws {
    try exerciseFacilityActions()
  }

  func testFacilityActionsChooseTheNumberInDarkAppearance() throws {
    try exerciseFacilityActions()
  }

  private func exerciseFacilityActions() throws {
    let app = application(textSize: "UICTContentSizeCategoryAccessibilityXXXL")
    app.launchArguments.append("--verify-call-handoff")
    app.launch()
    onboard(app)
    search("公開図書館", in: app)
    let detail = app.buttons["contact-detail"].firstMatch
    let call = app.buttons["03-0000-0000に電話をかける"].firstMatch
    assertIndependentTargets(detail, call)
    call.tap()
    confirmHandoff("tel:+81300000000", in: app)
    XCTAssertFalse(app.navigationBars["施設の情報"].exists)
    search("試験", in: app)
    let menu = app.buttons["choose-number"].firstMatch
    XCTAssertTrue(menu.waitForExistence(timeout: 10))
    XCTAssertTrue(menu.label.contains("試験歯科"))
    XCTAssertTrue(detail.label.contains("電話番号2件"))
    assertIndependentTargets(detail, menu)
    menu.tap()
    let landline = app.buttons["03-0000-0000"].firstMatch
    let mobile = app.buttons["090-1234-5678"].firstMatch
    XCTAssertTrue(landline.waitForExistence(timeout: 5))
    XCTAssertTrue(mobile.exists)
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.9)).tap()
    XCTAssertTrue(mobile.waitForNonExistence(timeout: 5))
    XCTAssertFalse(app.alerts.firstMatch.exists)
    XCTAssertEqual(app.searchFields.firstMatch.value as? String, "試験")
    menu.tap()
    mobile.tap()
    confirmHandoff("tel:+819012345678", in: app)
    XCTAssertFalse(app.navigationBars["施設の情報"].exists)
    detail.tap()
    let numbers = app.staticTexts.matching(identifier: "phone-number")
    for number in ["03-0000-0000", "090-1234-5678"] {
      let text = numbers.matching(NSPredicate(format: "label == %@", number)).firstMatch
      reveal(text, in: app)
      XCTAssertTrue(text.exists)
    }
    if menu.isHittable {
      menu.tap()
      XCTAssertTrue(mobile.waitForExistence(timeout: 5))
      app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.9)).tap()
      XCTAssertTrue(mobile.waitForNonExistence(timeout: 5))
      XCTAssertTrue(app.navigationBars["施設の情報"].exists)
      XCTAssertTrue(numbers.firstMatch.exists)
      XCTAssertFalse(app.alerts.firstMatch.exists)
    }
    goBack(app)
    XCTAssertEqual(app.searchFields.firstMatch.value as? String, "試験")
  }

  private func assertIndependentTargets(_ detail: XCUIElement, _ call: XCUIElement) {
    for target in [detail, call] {
      XCTAssertTrue(target.isHittable)
      XCTAssertFalse(target.label.isEmpty)
      XCTAssertGreaterThanOrEqual(target.frame.width, 44)
      XCTAssertGreaterThanOrEqual(target.frame.height, 44)
    }
    XCTAssertLessThanOrEqual(detail.frame.maxX, call.frame.minX)
  }

  private func confirmHandoff(_ url: String, in app: XCUIApplication) {
    let alert = app.alerts["Call handoff"]
    XCTAssertTrue(alert.waitForExistence(timeout: 5))
    XCTAssertTrue(alert.staticTexts[url].exists)
    alert.buttons["OK"].tap()
    XCTAssertTrue(alert.waitForNonExistence(timeout: 5))
  }

  /// The simulator reports no extension state, so the debug build reads one from the launch environment.
  func testCallerPromptAppearsOnlyWhileCallerNamesAreOff() throws {
    let app = application()
    app.launchEnvironment["PHONEBOOK_CALLER_STATUS"] = "off"
    app.launch()
    onboard(app)
    let prompt = app.descendants(matching: .any)["caller-prompt"]
    XCTAssertTrue(prompt.waitForExistence(timeout: 10))
    XCTAssertTrue(
      app.staticTexts["電話の相手を表示できます。"].exists)
    XCTAssertTrue(
      app.staticTexts.matching(
        NSPredicate(
          format: "label BEGINSWITH %@ AND label ENDSWITH %@", "設定で「", "」を許可してください。")
      ).firstMatch.exists)
    XCTAssertEqual(app.buttons["caller-prompt-settings"].label, "設定を開く")
    XCTAssertTrue(app.searchFields.firstMatch.isHittable)
    try auditVisibleContent(in: app, checksSearchHint: true)
    capture(app, name: "search-caller-prompt-off")
    let state = app.descendants(matching: .any)["caller-state"]
    openSettings(in: app)
    waitForLabel(state, "まだ許可していません")
    capture(app, name: "settings-caller-off")
    app.terminate()
    app.launchEnvironment["PHONEBOOK_CALLER_STATUS"] = "on"
    app.launch()
    XCTAssertTrue(app.descendants(matching: .any)["search-hint"].waitForExistence(timeout: 15))
    openSettings(in: app)
    waitForLabel(state, "許可しています")
    capture(app, name: "settings-caller-on")
    goBack(app)
    XCTAssertTrue(app.descendants(matching: .any)["search-hint"].waitForExistence(timeout: 5))
    XCTAssertFalse(prompt.exists)
    capture(app, name: "search-caller-prompt-on")
    // A running load and a refused reload keep the extension on and ask for no further press.
    for (status, label) in [
      ("loading", "準備しています"),
      ("onRetrying", "アプリを開き直すと、もう一度準備します"),
    ] {
      app.terminate()
      app.launchEnvironment["PHONEBOOK_CALLER_STATUS"] = status
      app.launch()
      XCTAssertTrue(app.descendants(matching: .any)["search-hint"].waitForExistence(timeout: 15))
      XCTAssertFalse(prompt.exists)
      openSettings(in: app)
      waitForLabel(state, label)
      capture(app, name: "settings-caller-\(status)")
      goBack(app)
    }
  }

  /// The harness runs the VerificationDebug build, which holds the QA verification screen.
  /// Every fixture record shares 03-0000-0000, so the scenario saves the next number.
  func testVerificationNumberAppearsInSearchAndClears() throws {
    let app = prepared()
    openVerification(in: app)
    let telephone = app.textFields["verification-telephone"]
    XCTAssertTrue(telephone.waitForExistence(timeout: 5))
    XCTAssertEqual(app.textFields["verification-label"].value as? String, "確認用の番号")
    telephone.tap()
    telephone.typeText("03-0000-0001")
    let save = app.buttons["verification-save"]
    reveal(save, in: app)
    save.tap()
    let message = app.staticTexts["verification-message"]
    waitUntil(
      "the save message appears", message.exists && message.label.hasPrefix("保存し"),
      observed: { message.exists ? "It shows “\(message.label)”." : "It doesn't exist." })
    XCTAssertFalse(message.label.contains("もう一度"))
    capture(app, name: "verification-saved")
    let replacement = app.buttons["verification-caller-replacement"]
    reveal(replacement, in: app)
    XCTAssertTrue(replacement.isEnabled)
    XCTAssertEqual(replacement.label, "全件の再登録を確認する")
    capture(app, name: "verification-caller-replacement")
    goBack(app)
    goBack(app)
    search("確認用", in: app)
    let result = app.descendants(matching: .any)["verification-result"]
    XCTAssertTrue(result.waitForExistence(timeout: 15))
    XCTAssertEqual(app.staticTexts["phone-number"].firstMatch.label, "03-0000-0001")
    XCTAssertTrue(app.buttons["03-0000-0001に電話をかける"].exists)
    XCTAssertFalse(app.staticTexts["empty-results"].exists)
    capture(app, name: "verification-search")
    // A new launch reads the saved verification number back from the App Group.
    app.terminate()
    app.launch()
    openVerification(in: app)
    XCTAssertEqual(telephone.value as? String, "03-0000-0001")
    let clear = app.buttons["verification-clear"]
    reveal(clear, in: app)
    clear.tap()
    waitUntil(
      "the clear message appears", message.exists && message.label.hasPrefix("消し"),
      observed: { message.exists ? "It shows “\(message.label)”." : "It doesn't exist." })
    XCTAssertFalse(message.label.contains("もう一度"))
    XCTAssertEqual(app.textFields["verification-label"].value as? String, "確認用の番号")
    goBack(app)
    goBack(app)
    search("確認用", in: app)
    XCTAssertTrue(app.staticTexts["empty-results"].waitForExistence(timeout: 15))
    XCTAssertFalse(result.exists)
  }

  func testPortraitLandscapeRoundTrip() throws {
    let app = prepared()
    app.terminate()
    app.launchEnvironment["PHONEBOOK_CALLER_STATUS"] = "on"
    app.launch()
    XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 15))
    let singleDisplay = XCUIScreen.screens.count == 1
    search("試験", in: app)
    app.buttons["contact-detail"].firstMatch.tap()
    XCTAssertTrue(app.navigationBars["施設の情報"].waitForExistence(timeout: 10))
    XCUIDevice.shared.orientation = .landscapeLeft
    waitUntil(
      "the device is landscape",
      XCUIDevice.shared.orientation == .landscapeLeft
        && (!singleDisplay
          || app.windows.firstMatch.frame.width > app.windows.firstMatch.frame.height)
    )
    XCTAssertTrue(app.navigationBars["施設の情報"].waitForExistence(timeout: 10))
    let field = app.searchFields.firstMatch
    let adjacentColumns = app.windows.firstMatch.frame.width > app.windows.firstMatch.frame.height
    if adjacentColumns {
      let address = app.staticTexts["contact-address"]
      XCTAssertTrue(address.waitForExistence(timeout: 5))
      XCTAssertLessThan(field.frame.maxX, address.frame.minX)
    } else {
      goBack(app)
    }
    XCTAssertEqual(field.value as? String, "試験")
    capture(app, name: "landscape-selected-facility")
    if adjacentColumns { app.buttons["clear-search"].tap() } else { clearField(field) }
    waitUntil(
      "the landscape search field is visible",
      field.exists && !field.frame.isEmpty && app.windows.firstMatch.frame.contains(field.frame),
      timeout: 5, observed: { field.debugDescription })
    // The compact clear action focuses the field, so typing needs no further tap.
    search("Index", in: app, focusField: adjacentColumns)
    waitForGroup("library", "100件", in: app)
    let results = app.collectionViews["search-results"]
    XCTAssertTrue(results.waitForExistence(timeout: 5))
    let names = results.buttons.matching(identifier: "contact-detail")
    if adjacentColumns {
      let second = names.element(boundBy: 1)
      let secondName = try XCTUnwrap(second.label.components(separatedBy: "、").first)
      names.element(boundBy: 0).tap()
      let source = app.buttons["source-link"]
      reveal(source, in: app, within: app.collectionViews["contact-content"])
      source.tap()
      XCTAssertTrue(app.navigationBars["電話番号のもとの情報"].waitForExistence(timeout: 5))
      let cell = results.cells.containing(
        NSPredicate(format: "identifier == %@ AND label == %@", "contact-detail", second.label)
      ).firstMatch
      XCTAssertTrue(cell.exists)
      let leadingInset = second.frame.minX - cell.frame.minX
      XCTAssertGreaterThan(leadingInset, 4)
      cell.coordinate(withNormalizedOffset: .zero)
        .withOffset(CGVector(dx: leadingInset - 4, dy: cell.frame.height / 2)).tap()
      XCTAssertTrue(
        app.collectionViews["contact-content"].staticTexts[secondName].waitForExistence(timeout: 5))
      XCTAssertEqual(field.value as? String, "Index")
    }
    let more = results.buttons["more-library"]
    for _ in 0..<8 where !more.isHittable { results.swipeUp() }
    XCTAssertTrue(more.isHittable)
    let previous = Set(names.allElementsBoundByIndex.map(\.label))
    more.tap()
    waitUntil(
      "the next library page appears",
      names.allElementsBoundByIndex.contains { !previous.contains($0.label) }, timeout: 10)
    let firstVisible = try XCTUnwrap(names.allElementsBoundByIndex.first { $0.isHittable })
    let anchor = names.matching(NSPredicate(format: "label == %@", firstVisible.label)).firstMatch
    let firstY = anchor.frame.minY
    results.swipeUp()
    waitUntil(
      "scrolling moves the results",
      !anchor.exists || anchor.frame.minY < firstY - 1,
      timeout: 5, observed: { results.debugDescription })
    capture(app, name: "landscape-scrolled-results")
    let bounds = results.frame.intersection(app.windows.firstMatch.frame)
    let top = max(bounds.minY, app.navigationBars["検索"].frame.maxY)
    let viewport = CGRect(x: bounds.minX, y: top, width: bounds.width, height: bounds.maxY - top)
    let contact = try XCTUnwrap(
      names.allElementsBoundByIndex.filter {
        $0.isHittable && viewport.contains($0.frame)
      }.min { abs($0.frame.midY - viewport.midY) < abs($1.frame.midY - viewport.midY) })
    let selected = names.matching(NSPredicate(format: "label == %@", contact.label)).firstMatch
    let selectedY = selected.frame.minY
    contact.tap()
    XCTAssertTrue(app.navigationBars["施設の情報"].waitForExistence(timeout: 10))
    capture(app, name: "landscape-detail")
    let wideWindow = app.windows.firstMatch.frame.width > app.windows.firstMatch.frame.height
    if wideWindow {
      let address = app.staticTexts["contact-address"]
      XCTAssertTrue(address.waitForExistence(timeout: 5))
      XCTAssertLessThan(field.frame.maxX, address.frame.minX)
    } else {
      goBack(app)
    }
    XCTAssertEqual(field.value as? String, "Index")
    XCTAssertTrue(selected.isHittable)
    XCTAssertEqual(selected.frame.minY, selectedY, accuracy: 1)
    waitUntil(
      "the search field accepts input after scrolling",
      field.exists && !field.frame.isEmpty && app.windows.firstMatch.frame.contains(field.frame),
      timeout: 5, observed: { field.debugDescription })
    field.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    field.typeText("あ")
    waitForValue(of: field, "editing changes the search after scrolling", timeout: 5) {
      $0 != "Index" && $0.contains("あ")
    }
    field.typeText("\n")
    if wideWindow { app.buttons["clear-search"].tap() } else { clearField(field) }
    XCTAssertTrue(app.descendants(matching: .any)["search-hint"].waitForExistence(timeout: 10))
    search("試験", in: app)
    app.buttons["contact-detail"].firstMatch.tap()
    XCTAssertTrue(app.navigationBars["施設の情報"].waitForExistence(timeout: 10))
    XCUIDevice.shared.orientation = .portrait
    waitUntil(
      "the device is portrait",
      XCUIDevice.shared.orientation == .portrait
        && (!singleDisplay
          || app.windows.firstMatch.frame.width < app.windows.firstMatch.frame.height)
    )
    reveal(app.buttons["source-link"], in: app)
    capture(app, name: "portrait-detail-after-rotation")
    app.buttons["source-link"].tap()
    XCTAssertTrue(app.staticTexts["source-license"].waitForExistence(timeout: 10))
    XCUIDevice.shared.orientation = .landscapeRight
    waitUntil(
      "the source device is landscape",
      XCUIDevice.shared.orientation == .landscapeRight
        && (!singleDisplay
          || app.windows.firstMatch.frame.width > app.windows.firstMatch.frame.height)
    )
    XCTAssertTrue(app.staticTexts["source-license"].exists)
    capture(app, name: "landscape-source-after-rotation")
    let wideSourceWindow = app.windows.firstMatch.frame.width > app.windows.firstMatch.frame.height
    if !wideSourceWindow {
      goBack(app)
      goBack(app)
    }
    XCTAssertEqual(field.value as? String, "試験")
    waitUntil(
      "the search field accepts input after rotating the source",
      field.exists && !field.frame.isEmpty && app.windows.firstMatch.frame.contains(field.frame),
      timeout: 5, observed: { field.debugDescription })
    field.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    field.typeText("\n")
    if wideSourceWindow {
      goBack(app)
      goBack(app)
    }
    XCTAssertEqual(app.searchFields.firstMatch.value as? String, "試験")
    waitForGroup("dental", "1件", in: app)
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
    waitForGroup("dental", "1件", in: app)
  }

  /// The download starts at the start button, not at launch, and the welcome names the complete archive's size boldly on a costly path.
  func testFirstDownloadWaitsForTheStartButton() throws {
    let app = application(bundled: .missing)
    app.launchEnvironment["PHONEBOOK_NETWORK_COST"] = "costly"
    app.launch()
    let start = app.buttons["onboarding-start"]
    XCTAssertTrue(start.waitForExistence(timeout: 15))
    let notice = app.descendants(matching: .any)["data-size-notice"]
    XCTAssertTrue(notice.waitForExistence(timeout: 5))
    waitUntil(
      "the welcome reads the size from the listing",
      (try? self.proxy().requests.contains("/api/datasets")) == true, timeout: 10)
    waitUntil(
      "the notice names the complete archive's size",
      notice.exists && notice.label.contains("受け取るデータは約0.1MBです。"), timeout: 10,
      observed: { notice.exists ? "It shows “\(notice.label)”." : "It doesn't exist." })
    capture(app, name: "onboarding-welcome-costly")
    app.terminate()
    app.launch()
    XCTAssertTrue(start.waitForExistence(timeout: 15))
    XCTAssertEqual(try datasetFiles(), 0)
    start.tap()
    waitUntil(
      "the start button starts the transfer", (try? self.datasetFiles()) == 1, timeout: 15,
      observed: { (try? self.proxy().log) ?? "" })
  }

  /// A slow transfer shows the three steps with a countdown under the current one, then the done state.
  func testFirstDownloadShowsItsStepsWhileReceiving() throws {
    let app = application(bundled: .missing)
    try proxy().failNext(.dataset, with: .paced(bytes: 128, after: .seconds(1)))
    app.launch()
    let start = app.buttons["onboarding-start"]
    XCTAssertTrue(start.waitForExistence(timeout: 15))
    start.tap()
    let later = app.buttons["onboarding-later"]
    XCTAssertTrue(later.waitForExistence(timeout: 10))
    later.tap()
    let progress = app.descendants(matching: .any)["sync-progress"]
    XCTAssertTrue(progress.waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["電話番号のデータを受け取っています"].exists)
    // The pace starts once the scenario watches, and the held rest keeps the countdown until 10 s pass without bytes.
    try proxy().release()
    waitForValue(of: progress, "the first step counts down in seconds", timeout: 20) {
      $0.contains("パーセント、データを受け取る、あと") && $0.hasSuffix("秒")
    }
    capture(app, name: "onboarding-receiving")
    let finish = app.buttons["onboarding-finish"]
    XCTAssertFalse(finish.isEnabled)
    try proxy().release()
    waitUntilSaved(finish, in: app, timeout: 60)
    XCTAssertTrue(app.staticTexts["準備ができました"].waitForExistence(timeout: 5))
    XCTAssertEqual(try proxy().injected, 1)
  }

  /// A transfer that stops partway reports a weak signal, says when it retries, and resumes from the kept bytes.
  func testFirstDownloadResumesAfterAWeakSignalAndAStop() throws {
    let app = application(bundled: .missing)
    try proxy().failNext(.dataset, with: .stall(bytes: 1_000))
    app.launch()
    let start = app.buttons["onboarding-start"]
    XCTAssertTrue(start.waitForExistence(timeout: 15))
    start.tap()
    let later = app.buttons["onboarding-later"]
    XCTAssertTrue(later.waitForExistence(timeout: 10))
    later.tap()
    let progress = app.descendants(matching: .any)["sync-progress"]
    XCTAssertTrue(progress.waitForExistence(timeout: 10))
    // The line appears after 10 s without bytes and stays while the fixture holds the connection, up to the app's 30 s request timeout.
    waitForValue(of: progress, "the time line reports a weak signal", timeout: 20) {
      $0.contains("通信がとぎれています、通信がもどると、自動で続きを受け取ります。")
    }
    capture(app, name: "onboarding-weak-signal")
    try proxy().release()
    waitUntilStopped(in: app)
    capture(app, name: "onboarding-download-stopped")
    let finish = app.buttons["onboarding-finish"]
    waitUntilSaved(finish, in: app, timeout: 60)
    let fixture = try proxy()
    let files = zip(zip(fixture.requests, fixture.ranges), fixture.outcomes).filter {
      $0.0.0.hasPrefix("/api/datasets/")
    }
    XCTAssertEqual(files.map(\.0.1), [nil, "bytes=1000-"], fixture.log)
    XCTAssertTrue(files.last?.1?.hasPrefix("206 with 1303 bytes") == true, fixture.log)
  }

  func testDirectoryFailureRecoversWithoutATap() throws {
    let app = application(bundled: .missing)
    try proxy().failNext(.dataset)
    app.launch()
    let start = app.buttons["onboarding-start"]
    XCTAssertTrue(start.waitForExistence(timeout: 15))
    start.tap()
    let later = app.buttons["onboarding-later"]
    XCTAssertTrue(later.waitForExistence(timeout: 10))
    later.tap()
    waitUntilStopped(in: app)
    capture(app, name: "directory-failure")
    let problem = app.staticTexts["sync-error"]
    let finish = app.buttons["onboarding-finish"]
    XCTAssertTrue(finish.waitForExistence(timeout: 10))
    waitUntilSaved(finish, in: app, timeout: 60)
    XCTAssertFalse(problem.exists)
    XCTAssertEqual(try proxy().injected, 1)
  }

  /// A listed delta from the bundled snapshot names its size boldly on a costly path, and the first run receives only the delta.
  func testDeltaNoticeReceivesOnlyTheDeltaFromTheBundle() throws {
    let updated = try XCTUnwrap(self.updated)
    let app = application()
    app.launchEnvironment["PHONEBOOK_API_ORIGIN"] = updated.origin
    app.launchEnvironment["PHONEBOOK_NETWORK_COST"] = "costly"
    app.launch()
    let notice = app.descendants(matching: .any)["data-size-notice"]
    XCTAssertTrue(notice.waitForExistence(timeout: 15))
    waitUntil(
      "the notice names the delta's size",
      notice.exists && notice.label.contains("受け取るデータは約0.1MBです。"), timeout: 15,
      observed: { notice.exists ? "It shows “\(notice.label)”." : "It doesn't exist." })
    XCTAssertEqual(notice.label, "受け取るデータは約0.1MBです。")
    capture(app, name: "onboarding-welcome-delta-costly")
    XCTAssertTrue(updated.requests.allSatisfy { !$0.hasPrefix("/api/datasets/") }, updated.log)
    app.buttons["onboarding-start"].tap()
    let later = app.buttons["onboarding-later"]
    XCTAssertTrue(later.waitForExistence(timeout: 10))
    later.tap()
    let finish = app.buttons["onboarding-finish"]
    waitUntilSaved(finish, in: app, timeout: 60)
    XCTAssertFalse(app.descendants(matching: .any)["bundled-date"].exists)
    let files = updated.requests.filter { $0.hasPrefix("/api/datasets/") }
    XCTAssertEqual(files.count, 1, updated.log)
    XCTAssertTrue(files.first?.contains("/directory-delta-") == true, updated.log)
    finish.tap()
    search("Updated public directory record", in: app)
    let result = app.buttons.matching(identifier: "contact-detail").matching(
      NSPredicate(format: "label CONTAINS %@", "Updated public directory record"))
    XCTAssertTrue(result.firstMatch.waitForExistence(timeout: 10))
  }

  /// A bundle that the listing names shows the no-transfer notice, plain on a costly path, and prepares its data with the receive step done.
  func testNoTransferNoticePreparesTheBundledData() throws {
    let app = application()
    app.launchEnvironment["PHONEBOOK_NETWORK_COST"] = "costly"
    app.launch()
    let notice = app.descendants(matching: .any)["data-size-notice"]
    XCTAssertTrue(notice.waitForExistence(timeout: 15))
    waitUntil(
      "the plan reads the listing",
      (try? self.proxy().requests.contains("/api/datasets")) == true, timeout: 10)
    XCTAssertEqual(notice.label, "通信せずに準備できます。")
    capture(app, name: "onboarding-welcome-no-transfer-costly")
    // The first run reads the listing again, and the fixture holds that reply while the scenario reads the ready step.
    try proxy().failNext(.listing, with: .paced(bytes: 0, after: .zero))
    app.buttons["onboarding-start"].tap()
    let later = app.buttons["onboarding-later"]
    XCTAssertTrue(later.waitForExistence(timeout: 10))
    later.tap()
    let progress = app.descendants(matching: .any)["sync-progress"]
    XCTAssertTrue(progress.waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["電話番号の準備をしています"].exists)
    XCTAssertFalse(app.staticTexts["電話番号のデータを受け取っています"].exists)
    XCTAssertEqual(progress.label, "電話番号の準備をしています")
    waitForValue(of: progress, "the preparing step is current", timeout: 10) {
      $0.contains("パーセント、さがせるように準備する")
    }
    capture(app, name: "onboarding-preparing")
    try proxy().release()
    try proxy().release()
    let finish = app.buttons["onboarding-finish"]
    waitUntilSaved(finish, in: app, timeout: 60)
    XCTAssertTrue(app.staticTexts["準備ができました"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.descendants(matching: .any)["bundled-date"].exists)
    XCTAssertEqual(try datasetFiles(), 0)
  }

  /// A first run with the service stopped ends with the bundled data alone and names its date.
  func testFirstRunWithTheServiceStoppedUsesTheBundledData() throws {
    try proxy().stop()
    let app = application()
    app.launch()
    let notice = app.descendants(matching: .any)["data-size-notice"]
    XCTAssertTrue(notice.waitForExistence(timeout: 15))
    XCTAssertEqual(notice.label, "通信せずに準備できます。")
    app.buttons["onboarding-start"].tap()
    let later = app.buttons["onboarding-later"]
    XCTAssertTrue(later.waitForExistence(timeout: 10))
    later.tap()
    let finish = app.buttons["onboarding-finish"]
    waitUntilSaved(finish, in: app, timeout: 60)
    XCTAssertTrue(app.staticTexts["準備ができました"].waitForExistence(timeout: 5))
    let date = app.staticTexts["bundled-date"]
    XCTAssertTrue(date.waitForExistence(timeout: 5))
    XCTAssertNotNil(date.label.range(of: #"^\d{4}年\d{1,2}月\d{1,2}日"#, options: .regularExpression))
    XCTAssertTrue(date.label.hasSuffix("のデータを使います。"), date.label)
    XCTAssertTrue(app.staticTexts["通信がもどると、新しいデータを自動で確認します。"].exists)
    capture(app, name: "onboarding-ready-bundled")
    finish.tap()
    search("試験", in: app)
    waitForGroup("dental", "1件", in: app)
    XCTAssertEqual(try proxy().requests, [])
  }

  /// Dark screens use system backgrounds and the primary button takes the system label color.
  /// The iOS gate turns the simulator's appearance dark for this scenario and light again after it.
  func testDarkAppearanceUsesSystemSurfacesAndLabelAccent() throws {
    let app = application()
    app.launch()
    let start = app.buttons["onboarding-start"]
    XCTAssertTrue(start.waitForExistence(timeout: 15))
    expectDarkAppearance(in: app, filled: start, screen: "onboarding")
    capture(app, name: "dark-onboarding")
    onboard(app)
    expectDarkAppearance(in: app, filled: nil, screen: "search")
    capture(app, name: "dark-search")
    openSettings(in: app)
    expectDarkAppearance(in: app, filled: nil, screen: "settings")
    capture(app, name: "dark-settings")
    goBack(app)
    search("公開図書館", in: app)
    let call = app.buttons["03-0000-0000に電話をかける"].firstMatch
    XCTAssertTrue(call.waitForExistence(timeout: 10))
    expectDarkAppearance(in: app, filled: nil, screen: "results")
    capture(app, name: "dark-results")
    app.buttons["contact-detail"].firstMatch.tap()
    XCTAssertTrue(app.navigationBars["施設の情報"].waitForExistence(timeout: 10))
    expectDarkAppearance(in: app, filled: nil, screen: "contact")
    capture(app, name: "dark-contact")
  }

  /// At the largest accessibility text size, an icon grows beside its label and nothing clips.
  func testLargestTextKeepsOnboardingControlsReadable() throws {
    let app = application(textSize: "UICTContentSizeCategoryAccessibilityXXXL")
    app.launchEnvironment["PHONEBOOK_CALLER_STATUS"] = "off"
    app.launch()
    let start = app.buttons["onboarding-start"]
    XCTAssertTrue(start.waitForExistence(timeout: 15))
    start.tap()
    let settings = app.buttons["onboarding-caller"]
    XCTAssertTrue(settings.waitForExistence(timeout: 10))
    XCTAssertEqual(settings.label, "設定を開く")
    XCTAssertGreaterThanOrEqual(settings.frame.height, 44)
    try app.performAccessibilityAudit(for: [.textClipped, .dynamicType, .hitRegion])
    try auditVisibleContent(in: app)
    capture(app, name: "largest-text-caller")
  }

  /// A failed automatic update shows nothing, keeps the saved data's date, and leaves search working.
  func testFailedAutomaticUpdateKeepsTheSavedDirectory() throws {
    let app = prepared()
    let date = dataDate(in: app)
    app.terminate()
    try proxy().failNext(.listing, with: .incomplete)
    app.launchEnvironment["PHONEBOOK_REFRESH_DUE"] = "1"
    app.launch()
    // The QA screen alone names the internal reason, which shows that the failed check has ended.
    openVerification(in: app)
    let reason = app.staticTexts["verification-problem"]
    XCTAssertTrue(reason.waitForExistence(timeout: 5))
    waitUntil(
      "the failed check ends", reason.exists && reason.label != "問題：なし", timeout: 45,
      observed: { reason.exists ? "It shows “\(reason.label)”." : "It doesn't exist." })
    goBack(app)
    XCTAssertTrue(app.navigationBars["設定"].exists)
    XCTAssertFalse(app.staticTexts["sync-error"].exists)
    capture(app, name: "directory-update-failure")
    goBack(app)
    XCTAssertEqual(dataDate(in: app), date)
    XCTAssertFalse(app.staticTexts["newer-app"].exists)
    goBack(app)
    goBack(app)
    XCTAssertFalse(app.staticTexts["sync-error"].exists)
    search("試験", in: app)
    waitForGroup("dental", "1件", in: app)
  }

  func testLandscapeLargeTextSettings() throws {
    let app = prepared(textSize: "UICTContentSizeCategoryAccessibilityXXXL")
    XCUIDevice.shared.orientation = .landscapeLeft
    openSettings(in: app)
    XCTAssertFalse(app.staticTexts["アプリのデータ"].exists)
    reveal(app.buttons["caller-settings"], in: app)
    try auditVisibleContent(in: app, measuredList: "integration-content")
    capture(app, name: "landscape-large-settings")
  }

  func testNativeListTextFitsAtDefaultAndLargestSizes() throws {
    let regular = try measureNativeListText(at: .large, argument: "UICTContentSizeCategoryL")
    let enlarged = try measureNativeListText(
      at: .accessibilityExtraExtraExtraLarge, argument: "UICTContentSizeCategoryAccessibilityXXXL")
    XCTAssertEqual(Set(regular.keys), Set(enlarged.keys))
    for (label, size) in regular {
      let large = try XCTUnwrap(enlarged[label])
      XCTAssertTrue(
        large.height > size.height + 1 || large.width > size.width + 1,
        "\(label) measured \(size) at the default size and \(large) at the largest size.")
    }
  }

  private func measureNativeListText(at category: UIContentSizeCategory, argument: String) throws
    -> [String: CGSize]
  {
    let app = application(textSize: argument)
    app.launchEnvironment["PHONEBOOK_CALLER_STATUS"] = "off"
    app.launch()
    onboard(app)
    let field = app.searchFields.firstMatch
    XCTAssertEqual(field.placeholderValue, "施設名または電話番号")
    try checkRenderedText("施設名または電話番号", in: field)
    let caller = app.buttons["caller-prompt-settings"]
    reveal(caller, in: app)
    XCTAssertEqual(caller.label, "設定を開く")
    try checkRenderedText("設定を開く", in: caller)
    openSettings(in: app)
    var sizes: [String: CGSize] = [:]
    let traits = UITraitCollection(preferredContentSizeCategory: category)
    func measure(_ identifier: String, below title: String, last: String) throws {
      if identifier == "integration-content" || identifier == "source-content" {
        try verifyToolbarText(title, in: app)
      }
      for (label, size) in try measureList(
        identifier, below: title, through: last, in: app, traits: traits)
      {
        sizes[identifier + "/" + label] = size
      }
    }
    try measure("integration-content", below: "設定", last: "QA用の確認")
    goBack(app)
    search("試験", in: app)
    app.buttons["contact-detail"].firstMatch.tap()
    try measure("contact-content", below: "施設の情報", last: "もとの情報を見る")
    app.buttons["source-link"].tap()
    try measure("source-content", below: "電話番号のもとの情報", last: "もとの資料を開く")
    if category == .large {
      let title = "電話番号のもとの情報"
      let heading = app.navigationBars[title].staticTexts[title].firstMatch
      let label = heading.exists ? heading : app.buttons["もとの資料を開く"]
      let expected = compactText(label.label)
      XCTAssertFalse(expected.isEmpty)
      let image = try XCTUnwrap(label.screenshot().image.cgImage)
      let lines = try recognizedText(in: image, languages: ["ja-JP", "en-US"])
      let line = try XCTUnwrap(
        lines.first { $0.topCandidates(1).contains { compactText($0.string).contains(expected) } })
      let box = line.boundingBox
      let crop = CGRect(
        x: box.minX * CGFloat(image.width), y: (1 - box.maxY) * CGFloat(image.height),
        width: box.width * CGFloat(image.width) / 2, height: box.height * CGFloat(image.height))
      let cropped = try XCTUnwrap(image.cropping(to: crop))
      XCTAssertFalse(try renderedText(in: cropped).contains(expected))
    }
    for key in [
      "integration-content/設定を開く", "integration-content/ライセンス",
      "contact-content/地図で見る", "contact-content/データの日付：2026年10月1日",
      "source-content/使うときの決まり：Creative Commons CC0 1.0 Universal",
    ] { XCTAssertNotNil(sizes[key], key) }
    app.terminate()
    return sizes
  }

  private func measureList(
    _ identifier: String, below title: String, through last: String, in app: XCUIApplication,
    traits: UITraitCollection
  ) throws -> [String: CGSize] {
    let list = app.collectionViews[identifier].firstMatch
    XCTAssertTrue(list.waitForExistence(timeout: 10), identifier)
    var sizes: [String: CGSize] = [:]
    var labels = Set<String>()
    let toolbar = listTextSnapshots(in: try app.navigationBars[title].snapshot()).map(\.frame)
    for _ in 0..<32 {
      let snapshot = try list.snapshot()
      let window = app.windows.firstMatch.frame
      let rect = snapshot.frame.intersection(window)
      let row = snapshot.children.first { $0.elementType == .cell }?.frame ?? rect
      let chrome = toolbar.filter { $0.minX < row.maxX && row.minX < $0.maxX }
      let top = max(rect.minY, chrome.map(\.maxY).max() ?? rect.minY)
      let viewport = CGRect(x: rect.minX, y: top, width: rect.width, height: rect.maxY - top)
      let texts = listTextSnapshots(in: snapshot)
      labels.formUnion(texts.map(\.label).filter { !$0.isEmpty })
      let visible = texts.filter {
        !$0.label.isEmpty && !$0.frame.isEmpty && $0.frame.minY >= viewport.minY - 1
          && $0.frame.maxY <= viewport.maxY + 1
      }
      for text in visible {
        let frame = text.frame
        XCTAssertTrue(
          try listLabelFits(text, in: list, traits: traits, window: app.windows.firstMatch),
          "\(text.label) in \(frame)")
        sizes[text.label] = frame.size
      }
      if visible.contains(where: { $0.label == last }) {
        XCTAssertTrue(
          labels.isSubset(of: Set(sizes.keys)),
          "Unmeasured text in \(identifier): \(labels.subtracting(sizes.keys))")
        return sizes
      }
      let origin = app.windows.firstMatch.coordinate(withNormalizedOffset: .zero)
      let step = viewport.height * 0.2
      let start = origin.withOffset(
        CGVector(dx: viewport.midX, dy: viewport.midY + step / 2))
      let end = origin.withOffset(
        CGVector(dx: viewport.midX, dy: viewport.midY - step / 2))
      start.press(
        forDuration: 0.01, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.1)
    }
    XCTFail("\(last) never became fully visible in \(identifier).")
    return sizes
  }

  func testCommonTasksPassAccessibilityAudits() throws {
    _ = try auditCommonTasks()
  }

  func testCommonTasksPassAccessibilityAuditsAtLargestTextSize() throws {
    let enlarged = try auditCommonTasks(textSize: "UICTContentSizeCategoryAccessibilityXXXL")
    let app = prepared()
    search("試験", in: app)
    app.buttons["contact-detail"].firstMatch.tap()
    let map = app.buttons["map-button"]
    reveal(map, in: app)
    map.tap()
    let confirmation = app.alerts.firstMatch
    XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
    let regular = mapConfirmationSize(in: confirmation, app: app)
    XCTAssertGreaterThan(regular.message, 0)
    XCTAssertGreaterThan(regular.actions, 0)
    XCTAssertGreaterThan(enlarged.message, regular.message * 2)
    XCTAssertGreaterThanOrEqual(enlarged.actions, 44)
    XCTAssertGreaterThanOrEqual(regular.actions, 44)
    capture(app, name: "accessibility-map-default-text")
    confirmationCancellation(in: app).tap()
  }

  func testCommonTasksPassAccessibilityAuditsInDarkAppearance() throws {
    _ = try auditCommonTasks()
  }

  private func auditCommonTasks(textSize: String = "UICTContentSizeCategoryL") throws
    -> (message: CGFloat, actions: CGFloat)
  {
    assertContrastViewport()
    let app = application(textSize: textSize)
    app.launchEnvironment["PHONEBOOK_CALLER_STATUS"] = "off"
    app.launch()
    let start = app.buttons["onboarding-start"]
    XCTAssertTrue(start.waitForExistence(timeout: 15))
    try auditVisibleContent(in: app)
    capture(app, name: "accessibility-onboarding")
    start.tap()
    let later = app.buttons["onboarding-later"]
    XCTAssertTrue(later.waitForExistence(timeout: 10))
    try auditVisibleContent(in: app)
    capture(app, name: "accessibility-caller-onboarding")
    reveal(later, in: app)
    later.tap()
    let finish = app.buttons["onboarding-finish"]
    XCTAssertTrue(finish.waitForExistence(timeout: 10))
    waitUntilSaved(finish, in: app, timeout: 60)
    try auditVisibleContent(in: app)
    capture(app, name: "accessibility-directory-ready")
    reveal(finish, in: app)
    finish.tap()

    openSettings(in: app)
    let caller = app.buttons["caller-settings"]
    reveal(caller, in: app)
    XCTAssertEqual(caller.label, "設定を開く")
    try auditVisibleContent(in: app, measuredList: "integration-content")
    capture(app, name: "accessibility-settings")
    goBack(app)

    search("試験", in: app)
    let detail = app.buttons["contact-detail"].firstMatch
    XCTAssertTrue(detail.waitForExistence(timeout: 15))
    let call = app.buttons["03-0000-0000に電話をかける"].firstMatch
    let menu = app.buttons["choose-number"].firstMatch
    reveal(menu, in: app)
    assertIndependentTargets(detail, menu)
    try auditVisibleContent(in: app)
    capture(app, name: "accessibility-name-search")
    reveal(detail, in: app, towardTop: true)
    detail.tap()
    XCTAssertTrue(app.navigationBars["施設の情報"].waitForExistence(timeout: 10))
    let map = app.buttons["map-button"]
    try auditVisibleContent(in: app, measuredList: "contact-content")
    capture(app, name: "accessibility-contact")
    reveal(call, in: app, towardTop: true)
    reveal(map, in: app)
    map.tap()
    let confirmation = app.alerts.firstMatch
    XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
    let confirmationSize = mapConfirmationSize(in: confirmation, app: app)
    XCTAssertTrue(confirmationCancellation(in: app).isHittable)
    XCTAssertTrue(confirmation.buttons["開く"].isHittable)
    XCTAssertFalse(map.isHittable)
    capture(app, name: "accessibility-map-confirmation")
    try auditModal(in: app, title: "地図を開きます", message: "施設の名前と住所をAppleのマップに送ります。")
    confirmationCancellation(in: app).tap()
    XCTAssertTrue(confirmation.waitForNonExistence(timeout: 5))
    let source = app.buttons["source-link"]
    reveal(source, in: app)
    source.tap()
    XCTAssertTrue(app.navigationBars["電話番号のもとの情報"].waitForExistence(timeout: 10))
    reveal(app.staticTexts["source-license"], in: app)
    XCTAssertEqual(
      app.staticTexts["source-license"].label,
      "使うときの決まり：Creative Commons CC0 1.0 Universal")
    try auditVisibleContent(in: app, measuredList: "source-content")
    capture(app, name: "accessibility-source")
    reveal(app.buttons["もとの資料を開く"], in: app)
    try auditVisibleContent(in: app, measuredList: "source-content")
    capture(app, name: "accessibility-source-actions")
    goBack(app)
    goBack(app)

    search("03-0000-0000", in: app)
    waitForGroup("library", "147件", in: app)
    reveal(call, in: app)
    XCTAssertTrue(app.windows.firstMatch.frame.contains(call.frame))
    try auditVisibleContent(in: app)
    capture(app, name: "accessibility-number-search")
    try auditOpenSourceInformation(in: app)
    app.terminate()
    return confirmationSize
  }

  private func auditOpenSourceInformation(in app: XCUIApplication) throws {
    let close = app.navigationBars.buttons["閉じる"]
    if close.exists, close.isHittable { close.tap() }
    _ = dataDate(in: app)
    let about = app.scrollViews["about-content"]
    let fullHeight = about.frame.maxY >= app.windows.firstMatch.frame.maxY - 1
    func audit(around target: XCUIElement) throws {
      try auditVisibleContent(in: app, floatingSheet: fullHeight ? nil : (about, target))
      reveal(target, in: app, within: about, swipes: 32)
    }
    let free = app.staticTexts["無料で使えます"]
    reveal(free, in: app, within: about)
    try audit(around: free)
    capture(app, name: "accessibility-about-free")
    let code = app.buttons["source-code-link"]
    reveal(code, in: app, within: about, swipes: 32)
    try audit(around: code)
    capture(app, name: "accessibility-about-source")
    code.tap()
    try checkSettingsLink(
      in: app, purpose: "GitHubでプログラムを開きます。", host: "github.com",
      attachment: "accessibility-source-code-confirmation")
    let privacy = app.buttons["privacy-policy-link"]
    let collection = app.staticTexts["privacy-collection"]
    reveal(
      fullHeight ? privacy : collection, in: app, within: about, swipes: 32, centered: fullHeight)
    XCTAssertTrue(collection.isHittable)
    XCTAssertTrue(about.frame.contains(collection.frame))
    try audit(around: collection)
    reveal(privacy, in: app, within: about, swipes: 32, centered: true)
    XCTAssertTrue(about.frame.contains(privacy.frame))
    privacy.tap()
    try checkSettingsLink(
      in: app, purpose: "ほかのサイトのページを開きます。", host: "www.dial.page",
      attachment: "accessibility-privacy-policy-confirmation")
  }

  private func checkSettingsLink(
    in app: XCUIApplication, purpose: String, host: String, attachment: String
  ) throws {
    let title = app.navigationBars["ページを開きます"]
    XCTAssertTrue(title.waitForExistence(timeout: 5))
    let disclosure = app.staticTexts["external-page-disclosure"]
    XCTAssertEqual(disclosure.label, purpose)
    XCTAssertEqual(disclosure.value as? String, "行き先：\(host)")
    try auditVisibleContent(in: app)
    capture(app, name: attachment)
    for button in [app.buttons["開く"], app.buttons["キャンセル"]] {
      reveal(button, in: app)
      XCTAssertTrue(button.isHittable)
      XCTAssertGreaterThanOrEqual(button.frame.height, 44)
    }
    app.buttons["キャンセル"].tap()
    XCTAssertTrue(title.waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.navigationBars["Public Phonebookについて"].exists)
  }

  private func accessibilityIssues(
    in app: XCUIApplication, for types: XCUIAccessibilityAuditType
  ) throws -> [XCUIAccessibilityAuditIssue] {
    var issues: [XCUIAccessibilityAuditIssue] = []
    try XCTContext.runActivity(named: "Audit accessibility") { _ in
      try app.performAccessibilityAudit(for: types) { issue in
        issues.append(issue)
        return true
      }
    }
    return issues
  }

  private func auditModal(in app: XCUIApplication, title: String, message: String) throws {
    assertNativeConfirmation(in: app, title: title, message: message)
    let before = app.debugDescription
    let system = ProcessInfo.processInfo.operatingSystemVersion
    let issues = try accessibilityIssues(in: app, for: .all.subtracting(.dynamicType))
    if !issues.isEmpty {
      attach(before, name: "modal-audit-before")
      attach(app.debugDescription, name: "modal-audit-after")
    }
    let nativeAlert = app.alerts.firstMatch.exists
    for issue in issues {
      // iPadOS 27.2 also reports background text without an element in Settings dialogs.
      if system.majorVersion == 27, system.minorVersion == 2, nativeAlert,
        issue.auditType == .elementDetection, issue.element == nil
      {
        continue
      }
      failAccessibilityIssue(issue)
    }
    assertNativeConfirmation(in: app, title: title, message: message)
  }

  private func assertNativeConfirmation(in app: XCUIApplication, title: String, message: String) {
    let confirmation = app.alerts.firstMatch
    XCTAssertTrue(confirmation.exists)
    XCTAssertEqual(confirmation.label, title)
    for text in [title, message] {
      let spokenText = text.replacingOccurrences(of: "\n", with: " ")
      let label = confirmation.staticTexts.allElementsBoundByIndex.first {
        $0.label.replacingOccurrences(of: "\n", with: " ") == spokenText
      }
      XCTAssertNotNil(label)
      if let label {
        let category: UIContentSizeCategory =
          app.launchArguments.contains("UICTContentSizeCategoryAccessibilityXXXL")
          ? .accessibilityExtraExtraExtraLarge : .large
        let font = UIFont.preferredFont(
          forTextStyle: .caption2,
          compatibleWith: UITraitCollection(preferredContentSizeCategory: category))
        let extent = (text as NSString).boundingRect(
          with: CGSize(width: label.frame.width + 1, height: .greatestFiniteMagnitude),
          options: [.usesLineFragmentOrigin], attributes: [.font: font], context: nil)
        XCTAssertGreaterThanOrEqual(label.frame.height + 2, extent.height, text)
      }
    }
    XCTAssertTrue(confirmation.buttons["開く"].isHittable)
    XCTAssertTrue(confirmationCancellation(in: app).isHittable)
  }

  private func failAccessibilityIssue(_ issue: XCUIAccessibilityAuditIssue) {
    attach("\(issue.auditType)\n\(issue.detailedDescription)", name: "accessibility-issue-details")
    if let element = issue.element {
      attach(element.debugDescription, name: "accessibility-issue-element")
      if issue.auditType == .contrast {
        let attachment = XCTAttachment(screenshot: element.screenshot())
        attachment.name = "contrast-element"
        attachment.lifetime = .keepAlways
        add(attachment)
      }
    } else {
      capture(XCUIApplication(), name: "accessibility-issue-screen")
    }
    // Record every audit finding while keeping navigation assertions fail-fast.
    let previous = continueAfterFailure
    continueAfterFailure = true
    defer { continueAfterFailure = previous }
    XCTFail(issue.compactDescription)
  }

  private func checkRenderedText(_ expected: String, in element: XCUIElement) throws {
    let image = try XCTUnwrap(element.screenshot().image.cgImage)
    let rendered = try renderedText(in: image)
    XCTAssertTrue(
      rendered.contains(compactText(expected)),
      "Expected “\(expected)” in the image, read “\(rendered)”.")
  }

  private func compactText(_ value: String) -> String {
    value.precomposedStringWithCompatibilityMapping.filter { !$0.isWhitespace }
  }

  private func renderedText(in image: CGImage) throws -> String {
    compactText(
      try recognizedText(in: image, languages: ["ja-JP", "en-US"])
        .compactMap { $0.topCandidates(1).first?.string }.joined())
  }

  private func recognizedText(in image: CGImage, languages: [String] = ["ja-JP"]) throws
    -> [VNRecognizedTextObservation]
  {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = languages
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage: image).perform([request])
    return request.results ?? []
  }

  /// Matches the sheet's rendered lines to accessibility labels at their on-screen positions.
  private func checkSheetText(
    _ sheet: XCUIElement, around target: XCUIElement, in window: XCUIElement, visible: CGRect
  ) throws {
    let frame = window.frame
    let region = sheet.frame.intersection(visible).insetBy(dx: 16, dy: 2)
    let image = try XCTUnwrap(window.screenshot().image.cgImage)
    let pixels = region.offsetBy(dx: -frame.minX, dy: -frame.minY).applying(
      CGAffineTransform(
        scaleX: CGFloat(image.width) / frame.width, y: CGFloat(image.height) / frame.height))
    let crop = try XCTUnwrap(image.cropping(to: pixels))
    let labels = listTextSnapshots(in: try sheet.snapshot())
    let buttons = Set(sheet.buttons.allElementsBoundByIndex.map(\.label))
    let anchor = try target.snapshot()
    var foundAnchor = false
    for line in try recognizedText(in: crop, languages: ["ja-JP", "en-US"]) {
      let box = line.boundingBox
      let bounds = CGRect(
        x: region.minX + box.minX * region.width, y: region.minY + (1 - box.maxY) * region.height,
        width: box.width * region.width, height: box.height * region.height)
      let candidates = line.topCandidates(3).map { normalizedLabel($0.string) }.filter {
        !$0.isEmpty
      }
      guard !candidates.isEmpty else { continue }
      let rows = labels.filter { $0.frame.intersects(bounds) }
      let matches = rows.filter { text in
        let label = normalizedLabel(text.label)
        return candidates.contains { candidate in
          label.contains(candidate)
            || (buttons.contains(text.label) && candidate.count == label.count + 1
              && candidate.hasSuffix(label))
        }
      }
      if matches.isEmpty, !rows.isEmpty,
        rows.allSatisfy({ clippedGlyphs(bounds, of: $0.frame, in: region) })
      {
        continue
      }
      XCTAssertFalse(matches.isEmpty, "No accessibility label for \(candidates) at \(bounds).")
      if anchor.frame.intersects(bounds), matches.contains(where: { $0.label == anchor.label }) {
        foundAnchor = true
      }
    }
    XCTAssertTrue(foundAnchor, "The sheet must show accessible text for \(anchor.label).")
  }

  private func normalizedLabel(_ text: String) -> String {
    text.precomposedStringWithCompatibilityMapping.lowercased().filter {
      $0.isLetter || $0.isNumber
    }
  }

  private func clippedGlyphs(_ line: CGRect, of label: CGRect, in region: CGRect) -> Bool {
    (line.minY <= region.minY + 1 && label.minY < region.minY)
      || (line.maxY >= region.maxY - 1 && label.maxY > region.maxY)
  }

  private func auditVisibleContent(
    in app: XCUIApplication, measuredList: String? = nil, checksSearchHint: Bool = false,
    floatingSheet: (content: XCUIElement, target: XCUIElement)? = nil
  ) throws {
    let window = app.windows.firstMatch
    let before = try window.snapshot()
    let system = ProcessInfo.processInfo.operatingSystemVersion
    let list = try measuredList.map { try app.collectionViews[$0].firstMatch.snapshot() }
    let nativeList = system.majorVersion == 27 && system.minorVersion == 2 ? list : nil
    let category: UIContentSizeCategory =
      app.launchArguments.contains("UICTContentSizeCategoryAccessibilityXXXL")
      ? .accessibilityExtraExtraExtraLarge : .large
    let traits = UITraitCollection(preferredContentSizeCategory: category)
    let bar = app.navigationBars.firstMatch
    let top = bar.exists ? bar.frame.maxY : before.frame.minY
    let visible = CGRect(
      x: before.frame.minX, y: top, width: before.frame.width, height: before.frame.maxY - top)
    let actions = app.descendants(matching: .any)["onboarding-actions"].firstMatch
    let footer = actions.exists ? actions.frame : nil
    let texts = staticTextSnapshots(in: before, viewport: visible, footer: footer)
    let checksSheet =
      UIDevice.current.userInterfaceIdiom == .pad
      && system.majorVersion == 27 && system.minorVersion == 2
    let inspectedSheet = checksSheet ? floatingSheet : nil
    if let inspectedSheet {
      let result = app.buttons["contact-detail"].firstMatch
      XCTAssertFalse(result.exists && result.isHittable)
      try checkSheetText(
        inspectedSheet.content, around: inspectedSheet.target, in: window, visible: visible)
    }
    let stableLayout = XCUIAccessibilityAuditType.all.subtracting([.dynamicType, .textClipped])
    for issue in try accessibilityIssues(in: app, for: stableLayout) {
      if inspectedSheet != nil, issue.auditType == .elementDetection, issue.element == nil {
        continue
      }
      if issue.auditType == .contrast, let element = issue.element,
        element.elementType == .staticText
      {
        let navigationText = app.navigationBars.staticTexts.allElementsBoundByIndex.contains {
          $0.label == element.label && $0.frame == element.frame
        }
        let frame = element.frame
        let matching = texts.filter {
          $0.element.identifier == element.identifier && $0.element.label == element.label
            && sameHorizontalBounds($0.element.frame, frame)
        }
        // XCTest can scroll a label into view after the initial snapshot.
        if !navigationText, !matching.isEmpty,
          matching.allSatisfy({ frameIsOutside($0.element.frame, in: $0.viewport) })
        {
          continue
        }
        if !navigationText, matching.count == 1, let match = matching.first,
          match.viewport.intersects(match.element.frame),
          !match.viewport.contains(match.element.frame),
          try recheckContrast(of: element, in: app)
        {
          continue
        }
        let candidates = texts.filter { $0.element.label == element.label }.map {
          "\($0.element.identifier): \($0.element.frame) in \($0.viewport)"
        }
        attach(
          "Window: \(visible)\nCandidates: \(candidates)\nReported: \(frame)",
          name: "contrast-visibility")
      }
      failAccessibilityIssue(issue)
    }
    var unnamed: [XCUIAccessibilityAuditIssue] = []
    for type in [XCUIAccessibilityAuditType.textClipped, .dynamicType] {
      let issues = try accessibilityIssues(in: app, for: type)
      for issue in issues {
        if type == .textClipped, issue.element == nil {
          unnamed.append(issue)
          continue
        }
        if checksSearchHint, system.majorVersion == 27, system.minorVersion == 2,
          issue.auditType == .textClipped, let element = issue.element
        {
          let caller = app.buttons["caller-prompt-settings"]
          if element.elementType == .searchField, element.placeholderValue == "施設名または電話番号" {
            try checkRenderedText("施設名または電話番号", in: element)
            continue
          }
          if element.elementType == .staticText, element.label == "設定を開く",
            caller.exists && caller.frame.contains(element.frame)
          {
            try checkRenderedText("設定を開く", in: caller)
            continue
          }
        }
        if try measuredListText(issue, in: nativeList, traits: traits, app: app) { continue }
        failAccessibilityIssue(issue)
      }
    }
    // Keep the audited scene in place until both text audits have finished.
    if !unnamed.isEmpty {
      guard let nativeList, try verifyClippingCandidates(in: nativeList, app: app, traits: traits)
      else {
        for issue in unnamed { failAccessibilityIssue(issue) }
        return
      }
    }
  }

  /// An unidentified clipping report requires checking the list, its toolbar, and any adjoining search.
  private func verifyClippingCandidates(
    in snapshot: any XCUIElementSnapshot, app: XCUIApplication, traits: UITraitCollection
  ) throws -> Bool {
    let title: String
    let first: String
    let last: String
    switch snapshot.identifier {
    case "integration-content":
      (title, first, last) = ("設定", "着信時の施設名表示", "QA用の確認")
    case "source-content":
      (title, first, last) = ("電話番号のもとの情報", "試験歯科 <script> & Test, clinic", "もとの資料を開く")
    default:
      return false
    }
    let bar = app.navigationBars[title]
    let list = app.collectionViews[snapshot.identifier].firstMatch
    guard bar.exists, list.exists, !app.alerts.firstMatch.exists else { return false }
    try verifyToolbarText(title, in: app)
    let search = app.searchFields.firstMatch
    if search.exists, search.isHittable {
      let sidebar = app.collectionViews["search-results"].firstMatch
      guard sidebar.exists, sidebar.frame.maxX <= list.frame.minX + 1,
        let query = search.value as? String, !query.isEmpty
      else { return false }
      try checkRenderedText(query, in: search)
      try verifyToolbarText("検索", in: app)
      for label in sidebar.staticTexts.allElementsBoundByIndex where label.isHittable {
        try checkRenderedText(label.label, in: label)
      }
      for button in sidebar.buttons.matching(identifier: "contact-detail").allElementsBoundByIndex
      where button.isHittable {
        for part in button.label.components(separatedBy: "、") {
          try checkRenderedText(part, in: button)
        }
      }
    }
    let start = list.staticTexts[first].firstMatch
    reveal(start, in: app, within: list, towardTop: true)
    let measured = try measureList(
      snapshot.identifier, below: title, through: last, in: app, traits: traits)
    let candidates = Set(listTextSnapshots(in: snapshot).map(\.label).filter { !$0.isEmpty })
    return measured[first] != nil && measured[last] != nil
      && candidates.isSubset(of: Set(measured.keys))
  }

  private func verifyToolbarText(_ title: String, in app: XCUIApplication) throws {
    let bar = app.navigationBars[title]
    let heading = bar.staticTexts[title].firstMatch
    let controls: XCUIElement
    if heading.exists {
      try checkRenderedText(title, in: heading)
      controls = bar
    } else {
      // The Duo's side toolbar carries the controls while its empty navigation bar names the screen.
      XCTAssertEqual(bar.identifier, title)
      XCTAssertEqual(bar.children(matching: .any).count, 0)
      let sidebars = app.toolbars.allElementsBoundByIndex.filter { toolbar in
        let bounds = toolbar.frame
        return bounds.height > bar.frame.height * 2
          && toolbar.buttons.allElementsBoundByIndex.contains { button in
            let frame = button.frame
            return button.isHittable && !frame.intersects(bar.frame)
              && (frame.midX > bounds.maxX - bounds.width / 4
                || frame.midX < bounds.minX + bounds.width / 4)
          }
      }
      XCTAssertEqual(sidebars.count, 1)
      controls = try XCTUnwrap(sidebars.first)
    }
    for label in controls.staticTexts.allElementsBoundByIndex
    where label.isHittable && label.label != title {
      try checkRenderedText(label.label, in: label)
    }
    for button in controls.buttons.allElementsBoundByIndex where button.isHittable {
      let labels = button.staticTexts.allElementsBoundByIndex.filter {
        $0.exists && !$0.label.isEmpty
      }
      for label in labels { try checkRenderedText(label.label, in: button) }
      if labels.isEmpty {
        XCTAssertTrue(button.identifier == "BackButton" || !button.label.isEmpty)
        XCTAssertTrue(controls.frame.contains(CGPoint(x: button.frame.midX, y: button.frame.midY)))
        let icon =
          ["close-settings", "open-settings", "BackButton"].contains(button.identifier)
          || button.label == "Back" || button.label == "戻る"
        if icon {
          let image = try XCTUnwrap(button.screenshot().image.cgImage)
          let glyph = normalizedLabel(try renderedText(in: image))
          XCTAssertTrue(
            ["", "x", "メ", "く"].contains(glyph),
            "Unexpected toolbar text “\(glyph)” in \(button.label).")
        } else {
          try checkRenderedText(button.label, in: button)
        }
      }
    }
  }

  /// The scroll edge can cover part of a label while XCTest samples its contrast.
  private func recheckContrast(of element: XCUIElement, in app: XCUIApplication)
    throws -> Bool
  {
    let label = element.label
    let identifier = element.identifier
    let original = element.frame
    let predicate = NSPredicate(
      format: "elementType == %d AND label == %@ AND identifier == %@",
      XCUIElement.ElementType.staticText.rawValue, label, identifier)
    let containers =
      app.scrollViews.containing(predicate).allElementsBoundByIndex
      + app.collectionViews.containing(predicate).allElementsBoundByIndex
    guard
      let list = containers.first(where: {
        $0.staticTexts.matching(predicate).allElementsBoundByIndex.contains {
          sameHorizontalBounds($0.frame, original)
        }
      })
    else { return false }
    let matches = list.staticTexts.matching(predicate).allElementsBoundByIndex.filter {
      sameHorizontalBounds($0.frame, original)
    }
    guard matches.count == 1, let target = matches.first,
      scroll(to: target, in: app, within: list, swipes: 16, fullyVisible: true)
    else {
      return false
    }
    let window = app.windows.firstMatch
    let captured = try window.snapshot()
    let bar = app.navigationBars.firstMatch
    let top = bar.exists ? bar.frame.maxY : captured.frame.minY
    let content = CGRect(
      x: captured.frame.minX, y: top, width: captured.frame.width, height: captured.frame.maxY - top
    )
    let targetFrame = target.frame
    let actions = app.descendants(matching: .any)["onboarding-actions"].firstMatch
    let footer = actions.exists ? actions.frame : nil
    let candidates = staticTextSnapshots(in: captured, viewport: content, footer: footer).filter {
      $0.element.identifier == identifier && $0.element.label == label
    }
    guard
      candidates.contains(where: {
        sameHorizontalBounds($0.element.frame, targetFrame)
          && abs($0.element.frame.midY - targetFrame.midY) < 1
          && $0.viewport.contains($0.element.frame)
      })
    else {
      attach(
        "Target \(targetFrame)\n\(candidates.map { "\($0.element.frame) in \($0.viewport)" })",
        name: "contrast-recheck-geometry")
      return false
    }
    return try accessibilityIssues(in: app, for: .contrast).allSatisfy {
      guard let reported = $0.element else { return false }
      return reported.label != label || reported.identifier != identifier
        || !sameHorizontalBounds(reported.frame, original)
    }
  }

  /// The list text scenario scrolls each native row into view at both real content sizes.
  private func measuredListText(
    _ issue: XCUIAccessibilityAuditIssue, in list: (any XCUIElementSnapshot)?,
    traits: UITraitCollection, app: XCUIApplication
  ) throws -> Bool {
    guard let list, let element = issue.element, let reported = try? element.snapshot(),
      reported.elementType == .staticText
    else {
      return false
    }
    guard
      let match = listTextSnapshots(in: list).first(where: {
        $0.label == reported.label && $0.identifier == reported.identifier
          && sameHorizontalBounds($0.frame, reported.frame)
      })
    else { return false }
    return try listLabelFits(
      match, in: app.collectionViews[list.identifier].firstMatch, traits: traits,
      window: app.windows.firstMatch)
  }

  private func listLabelFits(
    _ text: any XCUIElementSnapshot, in list: XCUIElement, traits: UITraitCollection,
    window: XCUIElement
  ) throws -> Bool {
    let frame = text.frame
    guard !text.label.isEmpty, !frame.isEmpty else { return false }
    let font = UIFont.preferredFont(
      forTextStyle: listTextStyle(text.label, in: list.identifier), compatibleWith: traits)
    let extent = (text.label as NSString).boundingRect(
      with: CGSize(width: frame.width + 1, height: .greatestFiniteMagnitude),
      options: [.usesLineFragmentOrigin], attributes: [.font: font], context: nil)
    if frame.height + 2 >= extent.height { return true }
    // A native Label can wrap a later line underneath its leading icon at accessibility sizes.
    let midpoint = CGPoint(x: frame.midX, y: frame.midY)
    guard
      let cell = list.cells.allElementsBoundByIndex.first(where: { $0.frame.contains(midpoint) })
    else {
      return false
    }
    let bounds = window.frame
    let lines = CGRect(
      x: cell.frame.minX, y: frame.minY, width: frame.maxX - cell.frame.minX, height: frame.height)
    guard bounds.contains(lines), list.frame.contains(lines),
      let image = window.screenshot().image.cgImage
    else { return false }
    let pixels = lines.offsetBy(dx: -bounds.minX, dy: -bounds.minY).applying(
      CGAffineTransform(
        scaleX: CGFloat(image.width) / bounds.width, y: CGFloat(image.height) / bounds.height))
    guard let crop = image.cropping(to: pixels) else { return false }
    return try renderedText(in: crop).contains(compactText(text.label))
  }

  private func listTextStyle(_ text: String, in list: String) -> UIFont.TextStyle {
    if text.hasPrefix("試験歯科") {
      return list == "contact-content" ? .title1 : .footnote
    }
    if ["歯医者", "電話番号", "住所", "電話番号のもとの情報", "公開元", "着信時の施設名表示"].contains(text)
      || text.hasPrefix("設定で「")
    {
      return .footnote
    }
    if list == "contact-content" && ["03-0000-0000", "090-1234-5678"].contains(text) {
      return .title2
    }
    return .body
  }

  private func listTextSnapshots(in snapshot: any XCUIElementSnapshot) -> [any XCUIElementSnapshot]
  {
    if snapshot.elementType == .staticText { return [snapshot] }
    let texts = snapshot.children.flatMap { listTextSnapshots(in: $0) }
    if texts.isEmpty && (snapshot.elementType == .button || snapshot.identifier == "caller-state") {
      return [snapshot]
    }
    return texts
  }

  private func staticTextSnapshots(
    in snapshot: any XCUIElementSnapshot, viewport: CGRect, footer: CGRect?
  )
    -> [(element: any XCUIElementSnapshot, viewport: CGRect)]
  {
    var bounds = textViewport(in: snapshot.elementType, frame: snapshot.frame, parent: viewport)
    if let footer {
      if snapshot.identifier == "onboarding-actions" { bounds = footer }
      if snapshot.elementType == .scrollView && snapshot.identifier == "onboarding-content" {
        bounds.size.height = max(0, min(bounds.maxY, footer.minY) - bounds.minY)
      }
    }
    let descendants = snapshot.children.flatMap {
      staticTextSnapshots(in: $0, viewport: bounds, footer: footer)
    }
    return (snapshot.elementType == .staticText ? [(snapshot, bounds)] : []) + descendants
  }

  private func textViewport(in type: XCUIElement.ElementType, frame: CGRect, parent: CGRect)
    -> CGRect
  {
    switch type {
    case .scrollView, .collectionView, .table, .sheet: parent.intersection(frame)
    default: parent
    }
  }

  private func frameIsOutside(_ frame: CGRect, in viewport: CGRect) -> Bool {
    [frame, viewport].allSatisfy {
      !$0.isEmpty && !$0.isInfinite && [$0.minX, $0.minY, $0.maxX, $0.maxY].allSatisfy(\.isFinite)
    } && frame.intersection(viewport).isEmpty
  }

  private func sameHorizontalBounds(_ first: CGRect, _ second: CGRect) -> Bool {
    // Accessibility snapshots can round the same point differently.
    let tolerance: CGFloat = 0.001
    return abs(first.minX - second.minX) < tolerance
      && abs(first.maxX - second.maxX) < tolerance
  }

  private func assertContrastViewport() {
    let viewport = CGRect(x: 0, y: 20, width: 100, height: 100)
    let clipped = CGRect(x: 0, y: 0, width: 20, height: 30)
    let offscreen = CGRect(x: 0, y: 200, width: 20, height: 20)
    let visible = CGRect(x: 0, y: 20, width: 20, height: 20)
    XCTAssertFalse(frameIsOutside(clipped, in: viewport))
    XCTAssertTrue(frameIsOutside(offscreen, in: viewport))
    XCTAssertFalse(frameIsOutside(visible, in: viewport))
    XCTAssertFalse(frameIsOutside(.zero, in: viewport))
    XCTAssertFalse(frameIsOutside(.infinite, in: viewport))
    XCTAssertFalse(frameIsOutside(clipped, in: .zero))
    XCTAssertFalse(frameIsOutside(clipped, in: .infinite))
    XCTAssertFalse(
      frameIsOutside(CGRect(x: CGFloat.nan, y: 0, width: 20, height: 20), in: viewport))
    let sheet = CGRect(x: 10, y: 10, width: 80, height: 80)
    let scroll = CGRect(x: 10, y: 15, width: 80, height: 90)
    let insideSheet = textViewport(in: .sheet, frame: sheet, parent: viewport)
    let insideScroll = textViewport(in: .scrollView, frame: scroll, parent: insideSheet)
    XCTAssertEqual(insideScroll, CGRect(x: 10, y: 20, width: 80, height: 70))
    XCTAssertEqual(textViewport(in: .other, frame: visible, parent: insideScroll), insideScroll)
    let firstLine = CGRect(x: 10, y: 20, width: 30, height: 8)
    XCTAssertTrue(clippedGlyphs(firstLine, of: scroll, in: insideScroll))
    XCTAssertFalse(clippedGlyphs(firstLine, of: visible, in: insideScroll))
    XCTAssertFalse(clippedGlyphs(firstLine.offsetBy(dx: 0, dy: 12), of: scroll, in: insideScroll))
    XCTAssertTrue(
      sameHorizontalBounds(
        visible, CGRect(x: 0, y: 200, width: CGFloat(20).nextUp, height: 30)))
    XCTAssertFalse(sameHorizontalBounds(visible, visible.offsetBy(dx: 1, dy: 0)))
    XCTAssertFalse(sameHorizontalBounds(visible, CGRect(x: 0, y: 20, width: 21, height: 20)))
    XCTAssertFalse(sameHorizontalBounds(visible, .infinite))
    XCTAssertFalse(
      sameHorizontalBounds(visible, CGRect(x: CGFloat.nan, y: 20, width: 20, height: 20)))
  }

  private func confirmationCancellation(in app: XCUIApplication) -> XCUIElement {
    app.alerts.firstMatch.buttons["キャンセル"]
  }

  private func mapConfirmationSize(in confirmation: XCUIElement, app: XCUIApplication)
    -> (message: CGFloat, actions: CGFloat)
  {
    let disclosure = confirmation.staticTexts.matching(
      NSPredicate(format: "label CONTAINS %@", "施設の名前と住所をAppleのマップに送ります。")
    ).firstMatch
    XCTAssertTrue(disclosure.waitForExistence(timeout: 5))
    XCTAssertTrue(disclosure.isHittable)
    XCTAssertEqual(
      confirmation.staticTexts.allElementsBoundByIndex.map(\.label).sorted(),
      ["地図を開きます", "施設の名前と住所をAppleのマップに送ります。"].sorted())
    XCTAssertEqual(
      confirmation.buttons.allElementsBoundByIndex.map(\.label).sorted(),
      (confirmation.buttons["キャンセル"].exists ? ["キャンセル", "開く"] : ["開く"]).sorted())
    return (
      disclosure.frame.height,
      min(confirmationCancellation(in: app).frame.height, confirmation.buttons["開く"].frame.height)
    )
  }

  func testAboutStaysInTheAppAndLicenseIsReadable() throws {
    let app = prepared()
    let date = dataDate(in: app)
    XCTAssertTrue(date.hasPrefix("データの日付："))
    XCTAssertTrue(app.staticTexts["privacy-collection"].waitForExistence(timeout: 5))
    XCTAssertFalse(
      app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "名前の一部でも"))
        .firstMatch.exists)
    let about = app.scrollViews["about-content"]
    reveal(about.staticTexts["Public Phonebookについて"], in: app, within: about, towardTop: true)
    capture(app, name: "about")
    let code = app.buttons["source-code-link"]
    XCTAssertTrue(code.waitForExistence(timeout: 5))
    reveal(code, in: app, within: about)
    capture(app, name: "about-open-source")
    let shot = XCTAttachment(screenshot: code.screenshot())
    shot.name = "about-source-code-button"
    shot.lifetime = .keepAlways
    add(shot)
    code.tap()
    try checkSettingsLink(
      in: app, purpose: "GitHubでプログラムを開きます。", host: "github.com",
      attachment: "source-code-confirmation")
    XCTAssertEqual(app.state, .runningForeground)
    let privacy = app.buttons["privacy-policy-link"]
    reveal(privacy, in: app, within: about, swipes: 32)
    privacy.tap()
    try checkSettingsLink(
      in: app, purpose: "ほかのサイトのページを開きます。", host: "www.dial.page",
      attachment: "privacy-policy-confirmation")
    let sources = app.buttons["sources-link"]
    reveal(sources, in: app, within: about)
    sources.tap()
    XCTAssertTrue(app.navigationBars["データのもと"].waitForExistence(timeout: 5))
    goBack(app)
    let license = app.buttons["license-link"]
    reveal(license, in: app, within: about)
    license.tap()
    XCTAssertTrue(app.navigationBars["ライセンス"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.state, .runningForeground)
    capture(app, name: "license")
  }

  func testSampleCityScreenshots() throws {
    let app = application(bundled: .sampleCity)
    app.launchEnvironment.removeValue(forKey: "PHONEBOOK_API_ORIGIN")
    app.launchArguments = ["-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
    app.launch()
    onboard(app)
    search("みほん", in: app)
    XCTAssertTrue(app.buttons["contact-detail"].firstMatch.waitForExistence(timeout: 10))
    let row = app.buttons["contact-detail"].firstMatch
    XCTAssertTrue(row.label.contains("サンプル"))
    capture(app, name: "sample-city-search")
    app.buttons.matching(identifier: "contact-detail").matching(
      NSPredicate(format: "label CONTAINS %@", "みほん市民図書館")
    )
    .firstMatch.tap()
    XCTAssertTrue(app.navigationBars["施設の情報"].waitForExistence(timeout: 10))
    let address = app.staticTexts["contact-address"]
    XCTAssertTrue(address.waitForExistence(timeout: 5))
    XCTAssertTrue(address.label.contains("みほん市"))
    XCTAssertTrue(address.label.contains("サンプル"))
    capture(app, name: "sample-city-contact")
    let map = app.buttons["map-button"]
    reveal(map, in: app)
    map.tap()
    XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: 5))
    capture(app, name: "sample-city-map-confirmation")
    confirmationCancellation(in: app).tap()
    let source = app.buttons["source-link"]
    reveal(source, in: app)
    source.tap()
    XCTAssertTrue(app.staticTexts["source-license"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["みほん市（サンプル）が公開したデータです。"].firstMatch.exists)
    let date = app.staticTexts["source-data-date"]
    XCTAssertTrue(date.waitForExistence(timeout: 5))
    XCTAssertEqual(date.label, "データの日付：2099年4月1日")
    capture(app, name: "sample-city-source")
    if XCUIScreen.screens.count == 1 {
      goBack(app)
      XCUIDevice.shared.orientation = .landscapeLeft
      waitUntil(
        "the sample window is landscape",
        app.windows.firstMatch.frame.width > app.windows.firstMatch.frame.height)
      reveal(address, in: app, towardTop: true)
      let field = app.searchFields.firstMatch
      XCTAssertTrue(field.isHittable)
      XCTAssertLessThan(field.frame.maxX, address.frame.minX)
      capture(app, name: "sample-city-landscape")
    }
  }

  func testLivePublicDirectorySearchAndSource() throws {
    let app = application(bundled: .shipped)
    let singleDisplay = XCUIScreen.screens.count == 1
    app.launchEnvironment.removeValue(forKey: "PHONEBOOK_API_ORIGIN")
    app.launch()
    onboard(app, timeout: 300)
    search("市立図書館", in: app, timeout: 180)
    let detail = app.buttons["contact-detail"].firstMatch
    XCTAssertTrue(detail.waitForExistence(timeout: 30))
    XCTAssertTrue(groupHeading(in: app).exists)
    XCTAssertFalse(detail.label.isEmpty)
    capture(app, name: "live-public-directory-search")
    detail.tap()
    XCTAssertTrue(app.navigationBars["施設の情報"].waitForExistence(timeout: 10))
    capture(app, name: "live-public-directory-contact")
    let source = app.buttons["source-link"]
    reveal(source, in: app)
    source.tap()
    XCTAssertTrue(app.staticTexts["source-license"].waitForExistence(timeout: 10))
    capture(app, name: "live-public-directory-source")
    backGesture(in: app)
    XCTAssertTrue(app.navigationBars["施設の情報"].waitForExistence(timeout: 10))
    backGesture(in: app, distance: 0.12)
    XCTAssertTrue(app.navigationBars["施設の情報"].exists)
    backGesture(in: app)
    let field = app.searchFields.firstMatch
    waitUntil("the device back gesture reveals search", field.exists && field.isHittable)
    XCTAssertEqual(field.value as? String, "市立図書館")
    detail.tap()
    XCTAssertTrue(app.navigationBars["施設の情報"].waitForExistence(timeout: 10))
    XCUIDevice.shared.orientation = .landscapeLeft
    waitUntil(
      "the device is landscape",
      XCUIDevice.shared.orientation == .landscapeLeft
        && (!singleDisplay
          || app.windows.firstMatch.frame.width > app.windows.firstMatch.frame.height)
    )
    XCTAssertTrue(app.navigationBars["施設の情報"].waitForExistence(timeout: 10))
    if app.windows.firstMatch.frame.width >= 641 {
      let address = app.staticTexts["contact-address"]
      reveal(address, in: app, towardTop: true)
      XCTAssertLessThan(field.frame.maxX, address.frame.minX)
    } else {
      goBack(app)
    }
    XCTAssertTrue(field.isHittable)
    XCTAssertEqual(field.value as? String, "市立図書館")
    capture(app, name: "live-public-directory-landscape")
  }

  func testBundledSearchStartupMeasurement() throws {
    let app = application(bundled: .shipped)
    app.launchEnvironment.removeValue(forKey: "PHONEBOOK_API_ORIGIN")
    app.launch()
    onboard(app, timeout: 300)
    let hint = app.descendants(matching: .any)["search-hint"]
    XCTAssertTrue(hint.waitForExistence(timeout: 180))
    let options = XCTMeasureOptions()
    options.iterationCount = 5
    options.invocationOptions = [.manuallyStart, .manuallyStop]
    measure(
      metrics: [
        XCTClockMetric(), XCTMemoryMetric(application: app),
        XCTApplicationLaunchMetric(waitUntilResponsive: true),
      ],
      options: options
    ) {
      app.terminate()
      startMeasuring()
      app.launch()
      XCTAssertTrue(hint.waitForExistence(timeout: 180))
      stopMeasuring()
    }
    search("市立図書館", in: app, timeout: 180)
    XCTAssertTrue(groupHeading(in: app).exists)
    capture(app, name: "measured-national-literal-results")
  }

  func testBundledSearchMemoryMeasurement() throws {
    let app = application(bundled: .shipped)
    app.launchEnvironment.removeValue(forKey: "PHONEBOOK_API_ORIGIN")
    app.launch()
    onboard(app, timeout: 300)
    XCTAssertTrue(app.descendants(matching: .any)["search-hint"].waitForExistence(timeout: 180))
    let options = XCTMeasureOptions()
    options.iterationCount = 3
    measure(metrics: [XCTMemoryMetric(application: app)], options: options) {
      for query in ["国立国会図書館", "図書館", "大学", "市立図書館"] {
        search(query, in: app, timeout: 180)
        XCTAssertTrue(groupHeading(in: app).exists)
      }
    }
  }

  /// The archive that a scenario's app starts its first run from.
  private enum Bundled {
    /// The fixture's baseline archive, which the fixture's baseline listing names.
    case fixture
    case sampleCity
    /// Missing files, so the first run downloads the complete archive.
    case missing
    /// The archive that the build copied into the app.
    case shipped
  }

  private static let checkout = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent()
  private static let fixtureBundle = checkout.appendingPathComponent(
    "target/ios/bundled-dataset/fixture")

  private func application(
    textSize: String = "UICTContentSizeCategoryL", bundled: Bundled = .fixture
  ) -> XCUIApplication {
    continueAfterFailure = false
    XCUIDevice.shared.orientation = .portrait
    let app = XCUIApplication()
    app.launchEnvironment["PHONEBOOK_API_ORIGIN"] = service?.origin ?? "http://localhost:3100"
    let directory: URL? =
      switch bundled {
      case .fixture: Self.fixtureBundle
      case .sampleCity:
        Self.checkout.appendingPathComponent("target/ios/screenshot-sample")
      case .missing: URL(fileURLWithPath: "/dev/null/missing")
      case .shipped: nil
      }
    if let directory {
      switch bundled {
      case .fixture, .sampleCity:
        XCTAssertTrue(
          FileManager.default.fileExists(
            atPath: directory.appendingPathComponent("directory.tsv.br").path))
        XCTAssertTrue(
          FileManager.default.fileExists(
            atPath: directory.appendingPathComponent("directory.json").path))
      case .missing, .shipped: break
      }
      app.launchEnvironment["PHONEBOOK_BUNDLED_ARCHIVE"] =
        directory.appendingPathComponent("directory.tsv.br").path
      app.launchEnvironment["PHONEBOOK_BUNDLED_ENTRY"] =
        directory.appendingPathComponent("directory.json").path
    }
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
    waitUntil(
      "the search field or the start button appears", field.exists || start.exists, timeout: 15)
    guard start.exists else { return }
    start.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    let later = app.buttons["onboarding-later"]
    XCTAssertTrue(later.waitForExistence(timeout: 10))
    later.tap()
    let finish = app.buttons["onboarding-finish"]
    XCTAssertTrue(finish.waitForExistence(timeout: 10))
    waitUntilSaved(finish, in: app, timeout: timeout)
    finish.tap()
    XCTAssertTrue(field.waitForExistence(timeout: 10))
  }

  /// Samples a system background and the label color in the dark appearance.
  private func expectDarkAppearance(
    in app: XCUIApplication, filled: XCUIElement?, screen: String,
    file: StaticString = #filePath, line: UInt = #line
  ) {
    let window = app.windows.firstMatch
    let pixels = Pixels(window.screenshot(), frame: window.frame)
    let margin = CGPoint(x: window.frame.maxX - 6, y: window.frame.midY)
    let backgrounds: [UIColor] = [
      .systemBackground, .systemGroupedBackground, .secondarySystemGroupedBackground,
    ]
    XCTAssertTrue(
      backgrounds.contains { pixels.matches($0, at: margin) },
      "The \(screen) surface has no matching dark system background.", file: file, line: line)
    if let filled {
      XCTAssertTrue(filled.exists, file: file, line: line)
      let inside = CGPoint(x: filled.frame.minX + 6, y: filled.frame.midY)
      XCTAssertTrue(
        pixels.matches(.label, at: inside),
        "The \(screen) button must use the dark appearance's label color.",
        file: file, line: line)
    }
  }

  private func goBack(_ app: XCUIApplication) {
    if app.navigationBars["設定"].exists, app.buttons["close-settings"].isHittable {
      app.buttons["close-settings"].tap()
      return
    }
    let back = app.buttons["BackButton"].firstMatch
    if back.exists {
      let titles = app.navigationBars.allElementsBoundByIndex.map(\.identifier)
      back.tap()
      waitUntil(
        "back navigation removes the previous screen",
        titles.contains { !app.navigationBars[$0].exists }, timeout: 5)
    } else {
      XCTAssertTrue(app.searchFields.firstMatch.isHittable)
    }
  }

  private func capture(_ app: XCUIApplication, name: String) {
    let shot = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
    shot.name = name
    shot.lifetime = .keepAlways
    add(shot)
  }

  private func attach(_ text: String, name: String) {
    let attachment = XCTAttachment(string: text)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  private func proxy() throws -> ServiceFixture {
    try XCTUnwrap(service)
  }

  /// The dataset file requests that the fixture received, which the listing request doesn't count among.
  private func datasetFiles() throws -> Int {
    try proxy().requests.filter { $0.hasPrefix("/api/datasets/") }.count
  }

  /// Types the query and waits until the shown results answer it, so results of an earlier query never stand in.
  private func search(
    _ text: String, in app: XCUIApplication, timeout: TimeInterval = 15,
    focusField: Bool = true,
    file: StaticString = #filePath, line: UInt = #line
  ) {
    let field = app.searchFields.firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 15))
    if let current = field.value as? String, !current.isEmpty,
      current != field.placeholderValue
    {
      clearField(field)
    }
    if focusField { field.tap() }
    field.typeText(text)
    waitForValue(of: field, "the field holds “\(text)”", file: file, line: line) { $0 == text }
    field.typeText("\n")
    waitForValue(
      of: app.descendants(matching: .any)["search-results"], "the results answer “\(text)”",
      timeout: timeout, file: file, line: line
    ) { $0 == text }
  }

  private func clearField(_ field: XCUIElement) {
    field.tap()
    let clear = field.buttons.firstMatch
    XCTAssertTrue(clear.waitForExistence(timeout: 5))
    clear.tap()
  }

  private func openSettings(in app: XCUIApplication) {
    let settings = app.buttons["open-settings"].firstMatch
    XCTAssertTrue(settings.waitForExistence(timeout: 15))
    settings.tap()
    XCTAssertTrue(app.navigationBars["設定"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.descendants(matching: .any)["caller-state"].waitForExistence(timeout: 10))
  }

  private func openVerification(in app: XCUIApplication) {
    openSettings(in: app)
    let item = app.buttons["QA用の確認"]
    reveal(item, in: app, within: app.collectionViews["integration-content"])
    item.tap()
    XCTAssertTrue(app.navigationBars["QA用の確認"].waitForExistence(timeout: 5))
  }

  /// Opens About and returns its line with the date of the saved data.
  private func dataDate(in app: XCUIApplication) -> String {
    openSettings(in: app)
    let about = app.buttons["Public Phonebookについて"]
    reveal(about, in: app, within: app.collectionViews["integration-content"])
    about.tap()
    XCTAssertTrue(app.descendants(matching: .any)["about-content"].waitForExistence(timeout: 5))
    let date = app.staticTexts["data-date"]
    XCTAssertTrue(date.waitForExistence(timeout: 10))
    return date.label
  }

  /// The first category heading on the results screen.
  private func groupHeading(in app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'group-'"))
      .firstMatch
  }

  /// Waits for results, finds a category heading wherever the lazy list puts it, and checks its count.
  private func waitForGroup(
    _ key: String, _ count: String, in app: XCUIApplication,
    file: StaticString = #filePath, line: UInt = #line
  ) {
    waitUntil(
      "results appear", app.buttons["contact-detail"].firstMatch.exists, timeout: 15,
      file: file, line: line)
    let heading = app.descendants(matching: .any)["group-\(key)"]
    if !scroll(to: heading, in: app, swipes: 12) {
      _ = scroll(to: heading, in: app, swipes: 12, towardTop: true)
    }
    waitUntil(
      "the \(key) heading shows \(count)", heading.exists && heading.label.hasSuffix(count),
      timeout: 5,
      observed: { heading.exists ? "It shows “\(heading.label)”." : "It doesn't exist." },
      file: file, line: line)
  }

  /// Waits as a named step and, on timeout, fails at the caller with the elapsed time.
  private func waitUntil(
    _ description: String, _ condition: @autoclosure @escaping () -> Bool,
    timeout: TimeInterval = 10, observed: () -> String = { "" },
    file: StaticString = #filePath, line: UInt = #line
  ) {
    XCTContext.runActivity(named: "Wait up to \(timeout) s until \(description)") { _ in
      let started = ContinuousClock.now
      let expected = XCTNSPredicateExpectation(
        predicate: NSPredicate { _, _ in MainActor.assumeIsolated { condition() } }, object: nil)
      let result = XCTWaiter.wait(for: [expected], timeout: timeout)
      guard result != .completed else { return }
      let elapsed = started.duration(to: .now).formatted(
        .units(allowed: [.seconds], width: .narrow, fractionalPart: .show(length: 1)))
      let ending = result == .timedOut ? "timed out" : "ended with result \(result.rawValue)"
      XCTFail(
        "Waiting until \(description) \(ending) after \(elapsed). \(observed())",
        file: file, line: line)
    }
  }

  /// Waits until one snapshot of the element has a value that satisfies the condition, and reports and returns that value.
  @discardableResult
  private func waitForValue(
    of element: XCUIElement, _ description: String, timeout: TimeInterval = 10,
    file: StaticString = #filePath, line: UInt = #line,
    where condition: @escaping (String) -> Bool
  ) -> String? {
    let reading = Reading()
    waitUntil(
      description, reading.accepts(element, condition), timeout: timeout,
      observed: { "It last read “\(reading.last ?? "nothing")”." }, file: file, line: line)
    if let accepted = reading.accepted {
      XCTContext.runActivity(named: "It read “\(accepted)”") { _ in }
    }
    return reading.accepted
  }

  /// Waits until one round of reads finds the stopped step with its retry time and without a retry button.
  /// The app retries 5 s after the stop and clears the step, so a later separate read could miss it.
  private func waitUntilStopped(
    in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line
  ) {
    let problem = app.staticTexts["sync-error"]
    let heading = app.staticTexts["データの受け取りが止まりました"]
    let retry = app.buttons["sync-retry"]
    waitUntil(
      "the stopped step says when it retries",
      (try? problem.snapshot())?.label == "データを受け取れませんでした。5秒後に、自動でもう一度受け取ります。" && heading.exists
        && !retry.exists,
      timeout: 20, observed: { self.saveState(app) }, file: file, line: line)
  }

  /// Waits for a completed save to enable the finish button, reporting the save state on timeout.
  private func waitUntilSaved(
    _ finish: XCUIElement, in app: XCUIApplication, timeout: TimeInterval,
    file: StaticString = #filePath, line: UInt = #line
  ) {
    waitUntil(
      "the saved directory enables the finish button", finish.isEnabled, timeout: timeout,
      observed: { self.saveState(app) }, file: file, line: line)
  }

  /// Describes the save progress and save error that the screen shows.
  private func saveState(_ app: XCUIApplication) -> String {
    let progress = app.descendants(matching: .any)["sync-progress"]
    let problem = app.staticTexts["sync-error"]
    let saving =
      progress.exists
      ? "save progress \(progress.value as? String ?? "without a value")" : "no save progress"
    let error = problem.exists ? "the save error “\(problem.label)”" : "no save error"
    return "The screen shows \(saving) and \(error)."
  }

  private func waitForLabel(
    _ element: XCUIElement, _ label: String, timeout: TimeInterval = 15,
    file: StaticString = #filePath, line: UInt = #line
  ) {
    waitUntil(
      "the element shows “\(label)”", element.exists && element.label == label, timeout: timeout,
      observed: { element.exists ? "It shows “\(element.label)”." : "It doesn't exist." },
      file: file, line: line)
  }

  private func reveal(
    _ element: XCUIElement, in app: XCUIApplication, within container: XCUIElement? = nil,
    swipes: Int = 16, towardTop: Bool = false, centered: Bool = false
  ) {
    XCTAssertTrue(
      scroll(
        to: element, in: app, within: container, swipes: swipes, towardTop: towardTop,
        centered: centered))
  }

  /// Scrolls within the window or presented container until the target's center is hittable.
  private func scroll(
    to element: XCUIElement, in app: XCUIApplication, within container: XCUIElement? = nil,
    swipes: Int, towardTop: Bool = false, centered: Bool = false, fullyVisible: Bool = false
  ) -> Bool {
    let surface = container ?? app.windows.firstMatch
    for attempt in 0...swipes {
      let frame = surface.frame
      let bar = app.navigationBars.firstMatch
      let top =
        bar.exists ? max(frame.minY, bar.frame.maxY) : frame.minY
      let keyboard = app.keyboards.firstMatch
      var bottom = keyboard.exists ? min(frame.maxY, keyboard.frame.minY) : frame.maxY
      if fullyVisible && surface.identifier == "onboarding-content" {
        let actions = app.descendants(matching: .any)["onboarding-actions"].firstMatch
        if actions.exists { bottom = min(bottom, actions.frame.minY) }
      }
      guard bottom > top else { return false }
      let viewport = CGRect(x: frame.minX, y: top, width: frame.width, height: bottom - top)
      let targetArea = centered ? viewport.insetBy(dx: 0, dy: viewport.height / 4) : viewport
      var scrollDown = towardTop
      var horizontal = frame.width / 2
      if element.exists {
        let target = element.frame
        let center = CGPoint(x: target.midX, y: target.midY)
        horizontal = center.x - frame.minX
        if element.isHittable
          && (fullyVisible ? viewport.contains(target) : targetArea.contains(center))
        {
          return true
        }
        if (fullyVisible ? target.minY : center.y) < targetArea.minY { scrollDown = true }
        if (fullyVisible ? target.maxY : center.y) > targetArea.maxY { scrollDown = false }
      } else if surface.elementType == .collectionView {
        // A split-view list can span the window while its cells occupy only the detail column.
        let row = surface.cells.firstMatch
        if row.exists { horizontal = row.frame.midX - frame.minX }
      }
      guard attempt < swipes else { return false }
      let origin = surface.coordinate(withNormalizedOffset: .zero)
      let start = origin.withOffset(
        CGVector(
          dx: horizontal, dy: top - frame.minY + (bottom - top) * (scrollDown ? 0.45 : 0.7)))
      let end = origin.withOffset(
        CGVector(
          dx: horizontal, dy: top - frame.minY + (bottom - top) * (scrollDown ? 0.7 : 0.45)))
      start.press(forDuration: 0.01, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.1)
    }
    return false
  }
}

/// The values that a wait read from one element, each from a single snapshot.
@MainActor private final class Reading {
  private(set) var last: String?
  private(set) var accepted: String?

  func accepts(_ element: XCUIElement, _ condition: (String) -> Bool) -> Bool {
    let value = (try? element.snapshot())?.value as? String
    last = value
    guard let value, condition(value) else { return false }
    accepted = value
    return true
  }
}

/// The pixels of one window screenshot, addressed by the window's points.
@MainActor private struct Pixels {
  static let channels = 4

  private let bytes: [UInt8]
  private let width: Int
  private let height: Int
  private let scale: CGFloat
  private let origin: CGPoint

  init(_ screenshot: XCUIScreenshot, frame: CGRect) {
    let image = screenshot.image.cgImage
    let width = image?.width ?? 0
    let height = image?.height ?? 0
    var buffer = [UInt8](repeating: 0, count: width * height * Self.channels)
    if let image {
      buffer.withUnsafeMutableBytes { raw in
        let context = CGContext(
          data: raw.baseAddress, width: width, height: height, bitsPerComponent: 8,
          bytesPerRow: width * Self.channels, space: CGColorSpaceCreateDeviceRGB(),
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        context?.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
      }
    }
    bytes = buffer
    self.width = width
    self.height = height
    scale = frame.width > 0 ? CGFloat(width) / frame.width : 1
    origin = frame.origin
  }

  func matches(_ color: UIColor, at point: CGPoint) -> Bool {
    let column = Int((point.x - origin.x) * scale)
    let row = Int((point.y - origin.y) * scale)
    guard (0..<width).contains(column), (0..<height).contains(row) else { return false }
    let dark = color.resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark))
    var red: CGFloat = 0
    var green: CGFloat = 0
    var blue: CGFloat = 0
    var alpha: CGFloat = 0
    guard dark.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return false }
    let start = (row * width + column) * Self.channels
    let sampled = bytes[start..<start + 3]
    return zip(sampled, [red, green, blue]).allSatisfy { byte, expected in
      abs(CGFloat(byte) - expected * 255) <= 6
    }
  }
}
