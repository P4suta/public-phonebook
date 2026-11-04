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
      if let run = testRun, run.totalFailureCount > 0 {
        attach(service?.log ?? "The fixture wasn't running.", name: "fixture-requests")
        if app.state == .runningForeground {
          capture(app, name: "failure")
          attach(app.debugDescription, name: "failure-accessibility-tree")
        }
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
    let notice = app.descendants(matching: .any)["data-size-notice"]
    XCTAssertTrue(notice.waitForExistence(timeout: 5))
    // The notice shows the national archive's known size until the listing answers with the fixture's size.
    waitUntil(
      "the notice shows the listed size",
      notice.exists && notice.label.contains("受け取るデータは約1MBです。"), timeout: 15,
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
    XCTAssertTrue(app.staticTexts["施設の名前か、電話番号を入れてください。"].exists)
    XCTAssertFalse(app.staticTexts["名前の一部でも、さがせます。"].exists)
    XCTAssertEqual(try proxy().requests.filter { $0.hasPrefix("/api/datasets/") }.count, 1)
    capture(app, name: "initial-search")
  }

  func testSearchGroupsResultsAndShowsMore() throws {
    let app = prepared()
    search("facility", in: app)
    // The 100 indexed libraries join the 46 regional libraries outside prefecture 13.
    waitForGroup("library", "146件", in: app)
    XCTAssertFalse(app.staticTexts["239件 見つかりました"].exists)
    let hidden = app.buttons["Index facility 003の住所などを見る"]
    XCTAssertFalse(hidden.exists)
    let more = app.buttons["more-library"]
    reveal(more, in: app)
    capture(app, name: "grouped-results")
    let requests = try proxy().requests.count
    more.tap()
    waitUntil("the more button disappears", !more.exists, timeout: 10)
    reveal(hidden, in: app)
    XCTAssertEqual(try proxy().requests.count, requests)
  }

  func testTelephoneSearchFindsEveryRecordForTheNumber() throws {
    let app = prepared()
    for query in ["03-0000-0000", "０３（００００）００００"] {
      search(query, in: app)
      // Every one of the 241 fixture records shares the number: 147 libraries, 47 clinics, and 47 dentists.
      waitForGroup("library", "147件", in: app)
      waitForGroup("medical", "47件", in: app)
      waitForGroup("dental", "47件", in: app)
    }
  }

  func testEmptyResultsAndLargeText() throws {
    let app = prepared(textSize: "UICTContentSizeCategoryAccessibilityXXXL")
    search("No matching facility 123456789", in: app)
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
    let alert = app.alerts["マップで開きます"]
    XCTAssertTrue(alert.waitForExistence(timeout: 5))
    XCTAssertTrue(
      alert.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Appleのマップ"))
        .firstMatch.exists)
    XCTAssertTrue(
      alert.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "名前と住所をAppleに送ります"))
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
      app.staticTexts["病院や役所などから電話がかかってきたとき、iPhoneの画面に施設の名前を出せます。"].exists)
    XCTAssertTrue(
      app.staticTexts.matching(
        NSPredicate(
          format: "label BEGINSWITH %@ AND label ENDSWITH %@", "iPhoneの設定で、", "を許可してください。")
      ).firstMatch.exists)
    XCTAssertEqual(app.buttons["caller-prompt-settings"].label, "iPhoneの設定を開く")
    XCTAssertTrue(app.searchFields.firstMatch.isHittable)
    // The audit flags the placeholder of the system search field from `.searchable`, which the prompt doesn't touch.
    try app.performAccessibilityAudit { issue in
      issue.auditType == .textClipped && issue.element?.elementType == .searchField
    }
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
      ("loading", "許可しています・iPhoneが読み込んでいます"),
      ("onRetrying", "許可しています・次にアプリを開いたときに反映します"),
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
    XCUIDevice.shared.orientation = .landscapeLeft
    waitUntil(
      "the window is landscape",
      app.windows.firstMatch.frame.width > app.windows.firstMatch.frame.height)
    capture(app, name: "landscape-before-search")
    search("試験", in: app)
    app.buttons["contact-detail"].firstMatch.tap()
    XCTAssertTrue(app.navigationBars["施設の情報"].waitForExistence(timeout: 10))
    capture(app, name: "landscape-detail")
    XCUIDevice.shared.orientation = .portrait
    waitUntil(
      "the window is portrait",
      app.windows.firstMatch.frame.width < app.windows.firstMatch.frame.height)
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
    waitForGroup("dental", "1件", in: app)
  }

  /// The download starts at the start button, not at launch, and the welcome names the size boldly on a costly path.
  func testFirstDownloadWaitsForTheStartButton() throws {
    let app = application()
    app.launchEnvironment["PHONEBOOK_NETWORK_COST"] = "costly"
    app.launch()
    let start = app.buttons["onboarding-start"]
    XCTAssertTrue(start.waitForExistence(timeout: 15))
    XCTAssertTrue(app.descendants(matching: .any)["data-size-notice"].waitForExistence(timeout: 5))
    waitUntil(
      "the welcome reads the size from the listing",
      (try? self.proxy().requests.contains("/api/datasets")) == true, timeout: 10)
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
    let app = application()
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
    let app = application()
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
      $0.contains("電波が弱いようです、つながると、続きから受け取ります。")
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
    let app = application()
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

  func testFailedAutomaticUpdateKeepsTheSavedDirectory() throws {
    let app = prepared()
    let date = dataDate(in: app)
    app.terminate()
    try proxy().failNext(.dataset, with: .incomplete)
    app.launchEnvironment["PHONEBOOK_REFRESH_DUE"] = "1"
    app.launch()
    openSettings(in: app)
    let problem = app.staticTexts["sync-error"]
    XCTAssertTrue(problem.waitForExistence(timeout: 30))
    XCTAssertTrue(problem.label.contains("前のデータのまま使えます"))
    capture(app, name: "directory-update-failure")
    goBack(app)
    XCTAssertEqual(dataDate(in: app), date)
    goBack(app)
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

  func testAboutStaysInTheAppAndLicenseIsReadable() throws {
    let app = prepared()
    let date = dataDate(in: app)
    XCTAssertTrue(date.hasPrefix("データの日付："))
    XCTAssertTrue(app.staticTexts["プライバシー"].waitForExistence(timeout: 5))
    XCTAssertFalse(
      app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "名前の一部でも"))
        .firstMatch.exists)
    capture(app, name: "about")
    let map = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "「地図で見る」から"))
      .firstMatch
    reveal(map, in: app)
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
    let detail = app.buttons["contact-detail"].firstMatch
    XCTAssertTrue(detail.waitForExistence(timeout: 30))
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
    _ text: String, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line
  ) {
    let field = app.searchFields.firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 15))
    field.tap()
    if let current = field.value as? String, !current.isEmpty,
      current != field.placeholderValue
    {
      field.buttons.firstMatch.tap()
    }
    field.typeText(text + "\n")
    waitForValue(
      of: app.descendants(matching: .any)["search-results"], "the results answer “\(text)”",
      timeout: 15, file: file, line: line
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
      "the \(key) heading shows \(count)", heading.exists && heading.label.hasSuffix(" \(count)"),
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
      (try? problem.snapshot())?.label == "5秒後に、自動でもう一度受け取ります。" && heading.exists
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
    for _ in 0..<swipes {
      var scrollDown = towardTop
      if element.exists {
        let frame = element.frame
        let center = CGPoint(x: frame.midX, y: frame.midY)
        if element.isHittable && app.windows.firstMatch.frame.contains(center) { return true }
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
    return element.exists && element.isHittable
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
