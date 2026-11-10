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
    XCTAssertTrue(notice.label.contains("Wi-Fiなどの速い回線につなぐと、早く終わります。"))
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
    XCTAssertTrue(app.staticTexts["施設の名前を入れてください。"].exists)
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
    XCTAssertTrue(app.staticTexts["contact-region"].firstMatch.exists)
    let more = app.buttons["more-library"]
    reveal(more, in: app)
    capture(app, name: "grouped-results")
    let names = app.staticTexts.matching(identifier: "contact-name")
    let previous = Set(names.allElementsBoundByIndex.map(\.label))
    let requests = try proxy().requests.count
    more.tap()
    waitUntil("the more button disappears", !more.exists, timeout: 10)
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
    let clear = app.buttons["clear-search-field"]
    XCTAssertTrue(clear.waitForExistence(timeout: 5))
    XCTAssertEqual(field.buttons.count, 0, field.debugDescription)
    XCTAssertEqual(app.buttons.matching(identifier: "clear-search-field").count, 1)
    XCTAssertTrue(clear.isHittable)
    XCTAssertFalse(clear.label.isEmpty)
    XCTAssertGreaterThanOrEqual(clear.frame.width, 44)
    XCTAssertGreaterThanOrEqual(clear.frame.height, 44)
    let border = app.descendants(matching: .any)["search-field-border"].firstMatch
    XCTAssertTrue(border.waitForExistence(timeout: 5))
    let menu = app.buttons["menu"]
    XCTAssertEqual(border.frame.minY, clear.frame.minY, accuracy: 1)
    XCTAssertEqual(border.frame.height, clear.frame.height, accuracy: 1)
    XCTAssertEqual(menu.frame.minY, clear.frame.minY, accuracy: 1)
    XCTAssertEqual(menu.frame.height, clear.frame.height, accuracy: 1)
    try app.performAccessibilityAudit(for: .hitRegion)
    capture(app, name: "search-one-clear-control")
    clear.tap()
    waitUntil("the search is empty", field.value as? String == field.placeholderValue)
    XCTAssertTrue(app.descendants(matching: .any)["search-hint"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["施設の名前を入れてください。"].exists)
    XCTAssertFalse(
      app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "読み仮名")).firstMatch.exists)
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
    XCTAssertEqual(app.staticTexts["contact-name"].firstMatch.label, "公開図書館")
    let heading = app.descendants(matching: .any)["group-library"]
    reveal(heading, in: app)
    XCTAssertTrue(heading.label.hasPrefix("図書館 "))
    reveal(app.staticTexts["contact-region"].firstMatch, in: app)
    XCTAssertEqual(
      app.staticTexts["contact-region"].firstMatch.label, "Test prefecture 13Test city 13")
    try app.performAccessibilityAudit()
    capture(app, name: "ranked-metadata-large-text")
  }

  func testEmptyResultsAndLargeText() throws {
    let app = prepared(textSize: "UICTContentSizeCategoryAccessibilityXXXL")
    search("zzzzzzzzzzzzzzzz", in: app)
    let empty = app.staticTexts["empty-results"]
    XCTAssertTrue(empty.waitForExistence(timeout: 15))
    XCTAssertEqual(empty.label, "あてはまる施設は0件です")
    reveal(app.staticTexts["名前の一部を入れるか、別の言葉でさがしてください。"], in: app)
    try app.performAccessibilityAudit()
    capture(app, name: "empty-large-text")
  }

  func testContactDetailShowsRegionSourceAndExternalLinkConfirmation() throws {
    let app = prepared()
    search("試験", in: app)
    waitForGroup("dental", "1件", in: app)
    XCTAssertEqual(app.staticTexts["contact-region"].label, "Test prefecture 13Test city 13")
    let name = "試験歯科 <script> & Test, clinic"
    XCTAssertTrue(app.staticTexts[name].exists)
    XCTAssertFalse(app.buttons[name].exists)
    let detail = app.buttons["contact-detail"].firstMatch
    XCTAssertEqual(detail.label, "\(name)の住所などを見る")
    detail.tap()
    XCTAssertTrue(app.navigationBars["施設の情報"].waitForExistence(timeout: 10))
    let address = app.staticTexts["contact-address"]
    XCTAssertTrue(address.waitForExistence(timeout: 5))
    XCTAssertEqual(address.label, "Test, address; Suite 2\\東")
    XCTAssertFalse(app.buttons["contact-address"].exists)
    let map = app.buttons["map-button"]
    reveal(map, in: app)
    XCTAssertEqual(map.label, "\(name)を地図で見る")
    capture(app, name: "contact-address")
    map.tap()
    let alert = app.sheets.firstMatch
    XCTAssertTrue(alert.waitForExistence(timeout: 5))
    XCTAssertTrue(
      alert.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Appleのマップ"))
        .firstMatch.exists)
    XCTAssertTrue(
      alert.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "名前と住所を送ります"))
        .firstMatch.exists)
    capture(app, name: "external-link-confirmation")
    confirmationCancellation(in: app).tap()
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

  func testPhoneNumberIsTextOverTheCallButton() throws {
    let app = prepared()
    search("試験", in: app)
    let number = app.staticTexts["phone-number"].firstMatch
    XCTAssertTrue(number.waitForExistence(timeout: 15))
    XCTAssertEqual(number.label, "03-0000-0000")
    XCTAssertFalse(app.buttons["03-0000-0000"].exists)
    let call = app.buttons["03-0000-0000に電話をかける"]
    XCTAssertTrue(call.exists)
    // Selectable text reports a frame with an inset around its glyphs, so its center marks its place.
    XCTAssertLessThan(number.frame.midY, call.frame.minY)
    XCTAssertFalse(
      app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "コピー"))
        .firstMatch.exists)
    app.buttons["contact-detail"].firstMatch.tap()
    XCTAssertTrue(app.navigationBars["施設の情報"].waitForExistence(timeout: 10))
    XCTAssertEqual(app.staticTexts["phone-number"].firstMatch.label, "03-0000-0000")
    XCTAssertFalse(
      app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "コピー"))
        .firstMatch.exists)
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
      app.staticTexts["病院や役所などから電話がかかってきたとき、画面に施設の名前を出せます。"].exists)
    XCTAssertTrue(
      app.staticTexts.matching(
        NSPredicate(
          format: "label BEGINSWITH %@ AND label ENDSWITH %@", "設定で、", "を許可してください。")
      ).firstMatch.exists)
    XCTAssertEqual(app.buttons["caller-prompt-settings"].label, "設定を開く")
    XCTAssertTrue(app.searchFields.firstMatch.isHittable)
    try app.performAccessibilityAudit()
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
      ("loading", "許可しています・準備しています"),
      ("onRetrying", "許可しています・次にアプリを開くと使えるようになります"),
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
    search("確認用", in: app)
    let result = app.descendants(matching: .any)["verification-result"]
    XCTAssertTrue(result.waitForExistence(timeout: 15))
    XCTAssertEqual(app.staticTexts["phone-number"].firstMatch.label, "03-0000-0001")
    XCTAssertTrue(app.buttons["03-0000-0001に電話をかける"].exists)
    XCTAssertFalse(app.staticTexts["empty-results"].exists)
    capture(app, name: "verification-search")
    // An active search field hides the menu, and a new launch also reads the saved number back.
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
    search("確認用", in: app)
    XCTAssertTrue(app.staticTexts["empty-results"].waitForExistence(timeout: 15))
    XCTAssertFalse(result.exists)
  }

  func testPortraitLandscapeRoundTrip() throws {
    let app = prepared()
    let singleDisplay = XCUIScreen.screens.count == 1
    XCUIDevice.shared.orientation = .landscapeLeft
    waitUntil(
      "the device is landscape",
      XCUIDevice.shared.orientation == .landscapeLeft
        && (!singleDisplay
          || app.windows.firstMatch.frame.width > app.windows.firstMatch.frame.height)
    )
    capture(app, name: "landscape-before-search")
    search("試験", in: app)
    app.buttons["contact-detail"].firstMatch.tap()
    XCTAssertTrue(app.navigationBars["施設の情報"].waitForExistence(timeout: 10))
    capture(app, name: "landscape-detail")
    let field = app.searchFields.firstMatch
    let detail = app.navigationBars["施設の情報"]
    XCTAssertLessThan(field.frame.maxX, detail.frame.minX)
    XCTAssertEqual(field.value as? String, "試験")
    field.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    field.typeText("\n")
    app.buttons["clear-search"].tap()
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
    XCTAssertEqual(field.value as? String, "試験")
    field.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    field.typeText("\n")
    capture(app, name: "landscape-source-after-rotation")
    goBack(app)
    goBack(app)
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
    XCTAssertTrue(app.staticTexts["アプリで使うデータを受け取っています"].exists)
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
    XCTAssertTrue(notice.label.contains("Wi-Fiなどの速い回線につなぐと、早く終わります。"))
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
    XCTAssertTrue(app.staticTexts["Updated public directory record"].waitForExistence(timeout: 10))
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
    XCTAssertTrue(notice.label.contains("データはアプリに入っています。"), notice.label)
    XCTAssertTrue(notice.label.contains("通信せずに準備できます。"), notice.label)
    capture(app, name: "onboarding-welcome-no-transfer-costly")
    // The first run reads the listing again, and the fixture holds that reply while the scenario reads the ready step.
    try proxy().failNext(.listing, with: .paced(bytes: 0, after: .zero))
    app.buttons["onboarding-start"].tap()
    let later = app.buttons["onboarding-later"]
    XCTAssertTrue(later.waitForExistence(timeout: 10))
    later.tap()
    let progress = app.descendants(matching: .any)["sync-progress"]
    XCTAssertTrue(progress.waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["アプリで使うデータを準備しています"].exists)
    XCTAssertFalse(app.staticTexts["アプリで使うデータを受け取っています"].exists)
    XCTAssertEqual(progress.label, "アプリで使うデータを準備しています")
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
    XCTAssertTrue(notice.label.contains("データはアプリに入っています。"), notice.label)
    app.buttons["onboarding-start"].tap()
    let later = app.buttons["onboarding-later"]
    XCTAssertTrue(later.waitForExistence(timeout: 10))
    later.tap()
    let finish = app.buttons["onboarding-finish"]
    waitUntilSaved(finish, in: app, timeout: 60)
    XCTAssertTrue(app.staticTexts["準備ができました"].waitForExistence(timeout: 5))
    let date = app.staticTexts["bundled-date"]
    XCTAssertTrue(date.waitForExistence(timeout: 5))
    XCTAssertTrue(date.label.hasPrefix("アプリに入っている、"), date.label)
    XCTAssertTrue(date.label.hasSuffix("のデータを使います。"), date.label)
    XCTAssertTrue(app.staticTexts["通信できるようになると、新しいデータを自動で受け取ります。"].exists)
    capture(app, name: "onboarding-ready-bundled")
    finish.tap()
    search("試験", in: app)
    waitForGroup("dental", "1件", in: app)
    XCTAssertEqual(try proxy().requests, [])
  }

  /// The dark appearance swaps black and white on the onboarding, search, contact, and settings screens.
  /// The iOS gate turns the simulator's appearance dark for this scenario and light again after it.
  func testDarkAppearanceSwapsBlackAndWhite() throws {
    let app = application()
    app.launch()
    let start = app.buttons["onboarding-start"]
    XCTAssertTrue(start.waitForExistence(timeout: 15))
    expectSwapped(in: app, filled: start, screen: "onboarding")
    capture(app, name: "dark-onboarding")
    onboard(app)
    expectSwapped(in: app, filled: nil, screen: "search")
    capture(app, name: "dark-search")
    // An active search field hides the menu, so Settings comes before the search.
    openSettings(in: app)
    expectSwapped(in: app, filled: nil, screen: "settings")
    capture(app, name: "dark-settings")
    goBack(app)
    search("試験", in: app)
    let call = app.buttons["03-0000-0000に電話をかける"].firstMatch
    XCTAssertTrue(call.waitForExistence(timeout: 10))
    expectSwapped(in: app, filled: call, screen: "results")
    capture(app, name: "dark-results")
    app.buttons["contact-detail"].firstMatch.tap()
    XCTAssertTrue(app.navigationBars["施設の情報"].waitForExistence(timeout: 10))
    expectSwapped(in: app, filled: call, screen: "contact")
    capture(app, name: "dark-contact")
  }

  /// At the largest accessibility text size, an icon grows beside its label and nothing clips.
  func testLargestTextScalesIconsBesideTheirLabels() throws {
    let app = application(textSize: "UICTContentSizeCategoryAccessibilityXXXL")
    app.launchEnvironment["PHONEBOOK_CALLER_STATUS"] = "off"
    app.launch()
    let start = app.buttons["onboarding-start"]
    XCTAssertTrue(start.waitForExistence(timeout: 15))
    start.tap()
    let settings = app.buttons["onboarding-caller"]
    XCTAssertTrue(settings.waitForExistence(timeout: 10))
    // The icon draws in the label's color at the leading edge, and at the default size it is 22 points tall.
    let height = try XCTUnwrap(iconHeight(in: settings, app: app))
    XCTAssertGreaterThan(height, 33, "The icon beside the label is \(height) points tall.")
    XCTAssertGreaterThanOrEqual(settings.frame.height, 44)
    try app.performAccessibilityAudit()
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
    openSettings(in: app)
    XCTAssertFalse(app.staticTexts["sync-error"].exists)
    capture(app, name: "directory-update-failure")
    goBack(app)
    XCTAssertEqual(dataDate(in: app), date)
    XCTAssertFalse(app.staticTexts["newer-app"].exists)
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
    try app.performAccessibilityAudit()
    capture(app, name: "landscape-large-settings")
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
    let confirmation = app.sheets.firstMatch
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
    let app = application(textSize: textSize)
    app.launchEnvironment["PHONEBOOK_CALLER_STATUS"] = "off"
    app.launch()
    let start = app.buttons["onboarding-start"]
    XCTAssertTrue(start.waitForExistence(timeout: 15))
    try app.performAccessibilityAudit()
    capture(app, name: "accessibility-onboarding")
    start.tap()
    let later = app.buttons["onboarding-later"]
    XCTAssertTrue(later.waitForExistence(timeout: 10))
    try app.performAccessibilityAudit()
    capture(app, name: "accessibility-caller-onboarding")
    reveal(later, in: app)
    later.tap()
    let finish = app.buttons["onboarding-finish"]
    XCTAssertTrue(finish.waitForExistence(timeout: 10))
    waitUntilSaved(finish, in: app, timeout: 60)
    try app.performAccessibilityAudit()
    capture(app, name: "accessibility-directory-ready")
    reveal(finish, in: app)
    finish.tap()

    openSettings(in: app)
    let caller = app.buttons["caller-settings"]
    reveal(caller, in: app)
    XCTAssertEqual(caller.label, "設定を開く")
    try app.performAccessibilityAudit()
    capture(app, name: "accessibility-settings")
    goBack(app)

    search("試験", in: app)
    let detail = app.buttons["contact-detail"].firstMatch
    XCTAssertTrue(detail.waitForExistence(timeout: 15))
    let call = app.buttons["03-0000-0000に電話をかける"].firstMatch
    reveal(call, in: app)
    try app.performAccessibilityAudit()
    capture(app, name: "accessibility-name-search")
    reveal(detail, in: app, towardTop: true)
    detail.tap()
    XCTAssertTrue(app.navigationBars["施設の情報"].waitForExistence(timeout: 10))
    let map = app.buttons["map-button"]
    reveal(map, in: app)
    reveal(call, in: app, towardTop: true)
    try auditVisibleContent(in: app)
    capture(app, name: "accessibility-contact")

    reveal(map, in: app)
    map.tap()
    let confirmation = app.sheets.firstMatch
    XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
    let confirmationSize = mapConfirmationSize(in: confirmation, app: app)
    XCTAssertTrue(confirmationCancellation(in: app).isHittable)
    XCTAssertTrue(confirmation.buttons["開く"].isHittable)
    XCTAssertFalse(map.isHittable)
    capture(app, name: "accessibility-map-confirmation")
    try app.performAccessibilityAudit(for: .all.subtracting(.dynamicType))
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
    try auditVisibleContent(in: app)
    capture(app, name: "accessibility-source")
    reveal(app.buttons["もとの資料を開く"], in: app)
    try auditVisibleContent(in: app)
    capture(app, name: "accessibility-source-actions")
    goBack(app)
    goBack(app)

    search("03-0000-0000", in: app)
    waitForGroup("library", "147件", in: app)
    try app.performAccessibilityAudit()
    capture(app, name: "accessibility-number-search")
    try auditOpenSourceInformation(in: app)
    app.terminate()
    return confirmationSize
  }

  private func auditOpenSourceInformation(in app: XCUIApplication) throws {
    let close = app.navigationBars.buttons["閉じる"]
    if close.exists, close.isHittable { close.tap() }
    _ = dataDate(in: app)
    reveal(app.staticTexts["無料で使えます"], in: app)
    try auditVisibleContent(in: app)
    capture(app, name: "accessibility-about-free")
    let code = app.buttons["source-code-link"]
    reveal(code, in: app, swipes: 32)
    try auditVisibleContent(in: app)
    capture(app, name: "accessibility-about-source")
    code.tap()
    let confirmation = app.sheets.firstMatch
    XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
    XCTAssertTrue(confirmation.buttons["開く"].isHittable)
    XCTAssertTrue(confirmationCancellation(in: app).isHittable)
    capture(app, name: "accessibility-source-code-confirmation")
    confirmationCancellation(in: app).tap()
    XCTAssertTrue(confirmation.waitForNonExistence(timeout: 5))
    let privacy = app.buttons["privacy-policy-link"]
    reveal(app.staticTexts["privacy-collection"], in: app, swipes: 32)
    try auditVisibleContent(in: app)
    reveal(privacy, in: app, swipes: 32)
    privacy.tap()
    XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
    XCTAssertTrue(
      confirmation.staticTexts.allElementsBoundByIndex.contains {
        $0.label.contains("https://www.dial.page/privacy")
      })
    capture(app, name: "accessibility-privacy-policy-confirmation")
    confirmationCancellation(in: app).tap()
    XCTAssertTrue(confirmation.waitForNonExistence(timeout: 5))
  }

  private func auditVisibleContent(in app: XCUIApplication) throws {
    try app.performAccessibilityAudit { issue in
      defer {
        if let element = issue.element {
          let attachment = XCTAttachment(string: element.debugDescription)
          attachment.name = "accessibility-issue-element"
          attachment.lifetime = .keepAlways
          self.add(attachment)
        }
      }
      guard issue.auditType == .contrast, let element = issue.element,
        element.elementType == .staticText
      else { return false }
      if app.navigationBars.staticTexts.allElementsBoundByIndex.contains(where: {
        $0.label == element.label && $0.frame == element.frame
      }) {
        return false
      }
      // XCTest fills the offscreen part of a clipped paragraph's image with black.
      let window = app.windows.firstMatch.frame
      let visible = CGRect(
        x: window.minX, y: app.navigationBars.firstMatch.frame.maxY,
        width: window.width, height: window.maxY - app.navigationBars.firstMatch.frame.maxY)
      return !visible.contains(element.frame)
    }
  }

  private func confirmationCancellation(in app: XCUIApplication) -> XCUIElement {
    let cancel = app.sheets.firstMatch.buttons["キャンセル"]
    return cancel.exists ? cancel : app.otherElements["PopoverDismissRegion"].firstMatch
  }

  private func mapConfirmationSize(in confirmation: XCUIElement, app: XCUIApplication)
    -> (message: CGFloat, actions: CGFloat)
  {
    let disclosure = confirmation.staticTexts.matching(
      NSPredicate(format: "label CONTAINS %@", "名前と住所を送ります。")
    ).firstMatch
    XCTAssertTrue(disclosure.waitForExistence(timeout: 5))
    XCTAssertTrue(disclosure.isHittable)
    XCTAssertEqual(
      confirmation.staticTexts.allElementsBoundByIndex.map(\.label).sorted(),
      ["マップで開きます", "Appleのマップで場所をさがすために、施設の名前と住所を送ります。"].sorted())
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
    reveal(app.scrollViews.staticTexts["Public Phonebookについて"], in: app, towardTop: true)
    capture(app, name: "about")
    let code = app.buttons["source-code-link"]
    XCTAssertTrue(code.waitForExistence(timeout: 5))
    reveal(code, in: app)
    capture(app, name: "about-open-source")
    code.tap()
    let confirmation = app.sheets.firstMatch
    XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
    XCTAssertTrue(
      confirmation.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "github.com"))
        .firstMatch.exists)
    capture(app, name: "source-code-confirmation")
    confirmationCancellation(in: app).tap()
    XCTAssertFalse(confirmation.exists)
    XCTAssertEqual(app.state, .runningForeground)
    let privacy = app.buttons["privacy-policy-link"]
    reveal(privacy, in: app, swipes: 32)
    privacy.tap()
    XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
    XCTAssertTrue(
      confirmation.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "/privacy"))
        .firstMatch.exists)
    confirmationCancellation(in: app).tap()
    XCTAssertTrue(confirmation.waitForNonExistence(timeout: 5))
    let sources = app.buttons["sources-link"]
    reveal(sources, in: app)
    sources.tap()
    XCTAssertTrue(app.navigationBars["データのもと"].waitForExistence(timeout: 5))
    goBack(app)
    let license = app.buttons["license-link"]
    reveal(license, in: app)
    license.tap()
    XCTAssertTrue(app.navigationBars["ライセンス"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.state, .runningForeground)
    capture(app, name: "license")
  }

  func testLivePublicDirectorySearchAndSource() throws {
    let app = application(bundled: .shipped)
    app.launchEnvironment.removeValue(forKey: "PHONEBOOK_API_ORIGIN")
    app.launch()
    onboard(app, timeout: 300)
    search("市立図書館", in: app, timeout: 180)
    let detail = app.buttons["contact-detail"].firstMatch
    XCTAssertTrue(detail.waitForExistence(timeout: 30))
    XCTAssertTrue(groupHeading(in: app).exists)
    XCTAssertTrue(app.staticTexts["contact-region"].firstMatch.exists)
    capture(app, name: "live-public-directory-search")
    detail.tap()
    XCTAssertTrue(app.navigationBars["施設の情報"].waitForExistence(timeout: 10))
    capture(app, name: "live-public-directory-contact")
    let source = app.buttons["source-link"]
    reveal(source, in: app)
    source.tap()
    XCTAssertTrue(app.staticTexts["source-license"].waitForExistence(timeout: 10))
    capture(app, name: "live-public-directory-source")
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
    /// Missing files, so the first run downloads the complete archive.
    case missing
    /// The archive that the build copied into the app.
    case shipped
  }

  /// The fixture's admitted pair, which the simulator reads from the checkout that built the tests.
  private static let fixtureBundle = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent()
    .appendingPathComponent("target/ios/bundled-dataset/fixture")

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
      case .missing: URL(fileURLWithPath: "/dev/null/missing")
      case .shipped: nil
      }
    if let directory {
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
    start.tap()
    let later = app.buttons["onboarding-later"]
    XCTAssertTrue(later.waitForExistence(timeout: 10))
    later.tap()
    let finish = app.buttons["onboarding-finish"]
    XCTAssertTrue(finish.waitForExistence(timeout: 10))
    waitUntilSaved(finish, in: app, timeout: timeout)
    finish.tap()
    XCTAssertTrue(field.waitForExistence(timeout: 10))
  }

  /// Requires a black surface beside the content and, inside a filled button, white ink.
  private func expectSwapped(
    in app: XCUIApplication, filled: XCUIElement?, screen: String,
    file: StaticString = #filePath, line: UInt = #line
  ) {
    let window = app.windows.firstMatch
    let pixels = Pixels(window.screenshot(), frame: window.frame)
    let margin = CGPoint(x: window.frame.maxX - 6, y: window.frame.midY)
    XCTAssertEqual(
      pixels.tone(at: margin), .black, "The \(screen) surface isn't black.", file: file, line: line)
    if let filled {
      XCTAssertTrue(filled.exists, file: file, line: line)
      let inside = CGPoint(x: filled.frame.minX + 6, y: filled.frame.midY)
      XCTAssertEqual(
        pixels.tone(at: inside), .white, "The \(screen) filled button isn't white.", file: file,
        line: line)
    }
  }

  /// The height in points of the white icon at the leading edge of a filled button's label.
  private func iconHeight(in button: XCUIElement, app: XCUIApplication) -> CGFloat? {
    let window = app.windows.firstMatch
    let pixels = Pixels(window.screenshot(), frame: window.frame)
    // The outline is 2 points wide, so the scan starts inside it.
    let area = button.frame.insetBy(dx: 4, dy: 4)
    guard let leading = pixels.firstColumn(in: area, where: { $0 == .white }) else { return nil }
    // A band narrower than the icon's default width holds only the icon, at any text size.
    let band = CGRect(x: leading, y: area.minY, width: 20, height: area.height)
    return pixels.extent(in: band, where: { $0 == .white })
  }

  private func goBack(_ app: XCUIApplication) {
    let back = app.buttons["BackButton"].firstMatch
    if back.exists {
      back.tap()
    } else if app.buttons["return-to-search"].exists {
      app.buttons["return-to-search"].tap()
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
    file: StaticString = #filePath, line: UInt = #line
  ) {
    let field = app.searchFields.firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 15))
    field.tap()
    if let current = field.value as? String, !current.isEmpty,
      current != field.placeholderValue
    {
      let clear = app.buttons["clear-search-field"]
      XCTAssertTrue(clear.waitForExistence(timeout: 5), file: file, line: line)
      clear.tap()
      field.tap()
    }
    field.typeText(text + "\n")
    waitForValue(
      of: app.descendants(matching: .any)["search-results"], "the results answer “\(text)”",
      timeout: timeout, file: file, line: line
    ) { $0 == text }
  }

  private func openSettings(in app: XCUIApplication) {
    let menu = app.buttons["メニュー"]
    XCTAssertTrue(menu.waitForExistence(timeout: 15))
    menu.tap()
    let settings = app.buttons["設定"]
    XCTAssertTrue(settings.waitForExistence(timeout: 5))
    settings.tap()
    XCTAssertTrue(app.navigationBars["設定"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.descendants(matching: .any)["caller-state"].waitForExistence(timeout: 10))
  }

  private func openVerification(in app: XCUIApplication) {
    let menu = app.buttons["メニュー"]
    XCTAssertTrue(menu.waitForExistence(timeout: 15))
    menu.tap()
    let item = app.buttons["QA用の確認"]
    XCTAssertTrue(item.waitForExistence(timeout: 5))
    item.tap()
    XCTAssertTrue(app.navigationBars["QA用の確認"].waitForExistence(timeout: 5))
  }

  /// Opens About and returns its line with the date of the saved data.
  private func dataDate(in app: XCUIApplication) -> String {
    let menu = app.buttons["メニュー"]
    XCTAssertTrue(menu.waitForExistence(timeout: 15))
    menu.tap()
    app.buttons["Public Phonebookについて"].tap()
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
    _ element: XCUIElement, in app: XCUIApplication, swipes: Int = 16, towardTop: Bool = false
  ) {
    XCTAssertTrue(scroll(to: element, in: app, swipes: swipes, towardTop: towardTop))
  }

  /// Scrolls until the element is hittable inside the window, and reports whether it got there.
  private func scroll(
    to element: XCUIElement, in app: XCUIApplication, swipes: Int, towardTop: Bool = false
  ) -> Bool {
    for attempt in 0...swipes {
      let window = app.windows.firstMatch
      let frame = window.frame
      let top =
        app.navigationBars.firstMatch.exists ? app.navigationBars.firstMatch.frame.maxY : frame.minY
      let keyboard = app.keyboards.firstMatch
      let bottom = keyboard.exists ? min(frame.maxY, keyboard.frame.minY) : frame.maxY
      guard bottom > top else { return false }
      let viewport = CGRect(x: frame.minX, y: top, width: frame.width, height: bottom - top)
      var scrollDown = towardTop
      if element.exists {
        let center = CGPoint(x: element.frame.midX, y: element.frame.midY)
        if element.isHittable && viewport.contains(center) { return true }
        if center.y < top { scrollDown = true }
        if center.y > bottom { scrollDown = false }
      }
      guard attempt < swipes else { return false }
      let origin = window.coordinate(withNormalizedOffset: .zero)
      let start = origin.withOffset(
        CGVector(
          dx: frame.width / 2, dy: top - frame.minY + (bottom - top) * (scrollDown ? 0.45 : 0.7)))
      let end = origin.withOffset(
        CGVector(
          dx: frame.width / 2, dy: top - frame.minY + (bottom - top) * (scrollDown ? 0.7 : 0.45)))
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
  enum Tone: Equatable { case black, white, other }

  /// Channel bounds for black and white, which leave room for the screenshot's color conversion.
  static let darkest: UInt8 = 24
  static let lightest: UInt8 = 231
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

  private func tone(column: Int, row: Int) -> Tone {
    guard (0..<width).contains(column), (0..<height).contains(row) else { return .other }
    let start = (row * width + column) * Self.channels
    let color = bytes[start..<start + 3]
    if color.allSatisfy({ $0 <= Self.darkest }) { return .black }
    if color.allSatisfy({ $0 >= Self.lightest }) { return .white }
    return .other
  }

  private func pixels(_ rect: CGRect) -> (columns: Range<Int>, rows: Range<Int>) {
    let left = max(0, Int(((rect.minX - origin.x) * scale).rounded(.up)))
    let right = min(width, Int(((rect.maxX - origin.x) * scale).rounded(.down)))
    let top = max(0, Int(((rect.minY - origin.y) * scale).rounded(.up)))
    let bottom = min(height, Int(((rect.maxY - origin.y) * scale).rounded(.down)))
    return (left..<max(left, right), top..<max(top, bottom))
  }

  func tone(at point: CGPoint) -> Tone {
    tone(column: Int((point.x - origin.x) * scale), row: Int((point.y - origin.y) * scale))
  }

  /// The leftmost point column inside `rect` that holds a matching pixel.
  func firstColumn(in rect: CGRect, where matches: (Tone) -> Bool) -> CGFloat? {
    let area = pixels(rect)
    let column = area.columns.first { column in
      area.rows.contains { matches(tone(column: column, row: $0)) }
    }
    return column.map { CGFloat($0) / scale + origin.x }
  }

  /// The height in points from the first to the last row inside `rect` that holds a matching pixel.
  func extent(in rect: CGRect, where matches: (Tone) -> Bool) -> CGFloat? {
    let area = pixels(rect)
    let rows = area.rows.filter { row in
      area.columns.contains { matches(tone(column: $0, row: row)) }
    }
    guard let first = rows.first, let last = rows.last else { return nil }
    return CGFloat(last - first + 1) / scale
  }
}
