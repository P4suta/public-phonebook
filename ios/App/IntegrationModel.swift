import BackgroundTasks
import CallKit
import Foundation
import Network
import OSLog
import Observation
import PhonebookCore
import PhonebookKit
import SwiftUI

enum ExtensionOperations {
  private static let logger = Logger(subsystem: "page.dial.publicphonebook", category: "caller")

  /// Reduces a Call Directory error to its code, which the reload decision reads without CallKit.
  private static func classified(_ error: any Error) -> any Error {
    let failure = error as NSError
    return failure.domain == CXErrorDomainCallDirectoryManager
      ? CallDirectoryFailure(code: failure.code) : error
  }

  static func callerEnabled() async throws -> Bool {
    try await withCheckedThrowingContinuation { continuation in
      CXCallDirectoryManager.sharedInstance.getEnabledStatusForExtension(
        withIdentifier: AppIdentity.callDirectory
      ) { status, error in
        if let error {
          let failure = error as NSError
          logger.error(
            "caller.status result=failed domain=\(failure.domain, privacy: .public) code=\(failure.code, privacy: .public)"
          )
          continuation.resume(throwing: classified(error))
        } else if status == .unknown {
          continuation.resume(throwing: ServiceError.invalidResponse)
        } else {
          continuation.resume(returning: status == .enabled)
        }
      }
    }
  }

  static func reloadCaller() async throws {
    try await withCheckedThrowingContinuation {
      (continuation: CheckedContinuation<Void, any Error>) in
      CXCallDirectoryManager.sharedInstance.reloadExtension(
        withIdentifier: AppIdentity.callDirectory
      ) { error in
        guard let error else { return continuation.resume() }
        let failure = error as NSError
        logger.error(
          "caller.reload result=failed domain=\(failure.domain, privacy: .public) code=\(failure.code, privacy: .public)"
        )
        continuation.resume(throwing: classified(error))
      }
    }
  }
}

struct NativeExtensionNotifier: ExtensionNotifier {
  func enabled(_ consumer: SnapshotConsumer) async throws -> Bool {
    switch consumer {
    case .caller: try await ExtensionOperations.callerEnabled()
    }
  }
  func notify(_ consumer: SnapshotConsumer) async throws {
    switch consumer {
    case .caller: try await ExtensionOperations.reloadCaller()
    }
  }
}

struct SavedGenerationReceipts: GenerationReceipts {
  /// Prefers the extension's own record, because turning it on in Settings loads the data without the app.
  func generation(for consumer: SnapshotConsumer) async -> UUID? {
    switch consumer {
    case .caller:
      if let store = try? AppIdentity.store(),
        let loaded = CallerFile.loadedGeneration(in: await store.root)
      {
        return loaded
      }
    }
    return UserDefaults.standard.string(forKey: consumer.rawValue + "Generation").flatMap(
      UUID.init(uuidString:))
  }
  func record(_ generation: UUID, for consumer: SnapshotConsumer) async {
    UserDefaults.standard.set(generation.uuidString, forKey: consumer.rawValue + "Generation")
  }
}

#if PHONEBOOK_VERIFICATION_TOOLS
  /// The caller state after a reload, and the Call Directory code that iOS returned, which the QA screen shows.
  struct CallerReload: Equatable {
    let status: CallerStatus
    let code: Int?
  }
#endif

@Observable @MainActor
final class IntegrationModel {
  /// The person pressed the start button once, so later launches and retries continue the first download.
  static let requestedKey = "firstDownloadRequested"
  static let onboardedKey = "onboardingComplete"
  /// The display steps with the latest sample at this interval, which the policy limits to one change a second.
  static let tick = Duration.milliseconds(200)

  var manifest: SnapshotManifest?
  private(set) var callerStatus = CallerStatus.checking
  var callerEnabled: Bool { callerStatus.isOn }
  /// The first download's display while it runs and after it ends, or nil before it starts and after it stops.
  private(set) var wait: WaitDisplay?
  /// The bar's share of the first download, which never falls while the app runs.
  private(set) var fraction = 0.0
  /// Why the first download stopped and when it retries, or nil while nothing stopped.
  private(set) var stopped: String?
  /// The path is expensive or constrained, such as mobile data or Low Data Mode.
  private(set) var costlyNetwork = false
  /// The archive's listed length, or nil before the listing answers.
  private(set) var downloadBytes: Int?
  var problem: String?
  private(set) var busy = false
  private var refreshing = false
  @ObservationIgnored private var operation: Task<Void, Never>?
  @ObservationIgnored private var retry: Task<Void, Never>?
  @ObservationIgnored private var ticker: Task<Void, Never>?
  @ObservationIgnored private var failures = 0
  @ObservationIgnored private var latest = SyncProgress(
    stage: SyncProgress.transfer, done: 0, total: 0, rows: 0, fraction: 0)
  @ObservationIgnored private var started = ContinuousClock.now
  @ObservationIgnored private var complete = false
  @ObservationIgnored private let monitor = NWPathMonitor()
  #if DEBUG
    /// Lets a UI scenario make the saved data due once without waiting a month.
    @ObservationIgnored private var forcedDue =
      ProcessInfo.processInfo.environment["PHONEBOOK_REFRESH_DUE"] == "1"
    /// Lets a UI scenario draw a caller state that the simulator doesn't report.
    @ObservationIgnored private let forcedCallerStatus = ProcessInfo.processInfo.environment[
      "PHONEBOOK_CALLER_STATUS"
    ].flatMap(CallerStatus.init(rawValue:))
    /// Lets a UI scenario draw the welcome notice of a mobile data or Low Data Mode path.
    @ObservationIgnored private let forcedCostlyNetwork =
      ProcessInfo.processInfo.environment["PHONEBOOK_NETWORK_COST"] == "costly"
  #endif
  @ObservationIgnored private let sync: SyncEngine
  @ObservationIgnored private let automatic: AutomaticUpdate
  @ObservationIgnored private let api: APIClient
  @ObservationIgnored private let store: SnapshotStore
  @ObservationIgnored private let origin: String
  /// The path that iOS reported last, which the update decision reads.
  @ObservationIgnored private var path = UpdatePath(expensive: false, constrained: false)

  init(api: APIClient, store: SnapshotStore) {
    origin = api.origin.absoluteString
    self.api = api
    self.store = store
    sync = SyncEngine(api: api, store: store, trace: SystemTraceSink())
    automatic = BackgroundRefresh.automatic(api: api, store: store)
    monitor.pathUpdateHandler = { [weak self] path in
      let reported = UpdatePath(expensive: path.isExpensive, constrained: path.isConstrained)
      Task { @MainActor [weak self] in self?.report(reported) }
    }
    monitor.start(queue: DispatchQueue(label: "network-path", qos: .utility))
  }

  /// Records the path, and lets a waiting automatic transfer start on a path that is neither expensive nor constrained.
  private func report(_ reported: UpdatePath) {
    path = reported
    costlyNetwork = !reported.inexpensive
    // Only a waiting transfer needs the report, so other reports leave the app free for the next check.
    if manifest != nil, !busy, DefaultsUpdateRecords().load().state.waiting != nil {
      update(.path(updatePath))
    }
  }

  /// The path that the decision reads, which a debug UI scenario can force to be costly.
  private var updatePath: UpdatePath {
    costlyPath ? UpdatePath(expensive: true, constrained: path.constrained) : path
  }

  /// The first download runs or still shows its last step.
  var receiving: Bool { wait.map { !$0.finished } ?? false }
  /// The saved data is ready and the first download has nothing more to show.
  var ready: Bool { manifest != nil && !receiving }
  var megabytes: Int {
    DownloadSchedule.megabytes(downloadBytes ?? DownloadSchedule.knownArchiveBytes)
  }

  private var requested: Bool {
    UserDefaults.standard.bool(forKey: Self.requestedKey)
      || UserDefaults.standard.bool(forKey: Self.onboardedKey)
  }

  /// The path is expensive or constrained, which a debug UI scenario can also force.
  var costlyPath: Bool {
    #if DEBUG
      if forcedCostlyNetwork { return true }
    #endif
    return costlyNetwork
  }

  /// Starts the first download when the person presses the start button, and remembers that they did.
  func startFirstDownload() {
    UserDefaults.standard.set(true, forKey: Self.requestedKey)
    if manifest == nil { update(.first) }
  }

  /// Reads the saved data, continues a first download that the person started, and runs a due daily check.
  func refresh() async {
    guard !refreshing else { return }
    refreshing = true
    defer { refreshing = false }
    if !busy {
      do { manifest = try await store.manifest() } catch {
        manifest = nil
        problem = "アプリのデータを開けなかったので、受け取り直します。"
      }
    }
    if let manifest, !busy {
      await notifyExtensions(manifest)
    } else {
      await readExtensionStates()
    }
    guard !busy else { return }
    guard let manifest else {
      // Returning to the app retries a stopped first download now.
      if requested { update(.first) } else { await readDownloadSize() }
      return
    }
    try? BackgroundRefresh.schedule(manifest: manifest)
    // Data saved from another origin, or a debug UI scenario, makes the check due now.
    if manifest.origin != origin || consumeForcedDue() {
      DefaultsUpdateRecords().save(UpdateRecord())
    }
    update(.check)
  }

  private func readDownloadSize() async {
    guard downloadBytes == nil else { return }
    downloadBytes = try? await api.datasets().archive.bytes
  }

  private func consumeForcedDue() -> Bool {
    #if DEBUG
      if forcedDue {
        forcedDue = false
        return true
      }
    #endif
    return false
  }

  /// What a run of the update path does.
  enum Run: Equatable {
    /// The first download, which the person started with the start button.
    case first
    /// The daily check at a launch or a return to the foreground.
    case check
    /// A path report, which starts a waiting automatic transfer.
    case path(UpdatePath)
    /// A transfer that the person started from the QA screen.
    case person
  }

  /// Runs the first download with its display and announcements, or a silent update.
  private func update(_ run: Run) {
    let first = run == .first
    guard !busy else { return }
    retry?.cancel()
    retry = nil
    stopped = nil
    // A path report reads nothing, so it keeps the problem that the last check found.
    if case .path = run {} else { problem = nil }
    busy = true
    if first {
      latest = SyncProgress(
        stage: SyncProgress.transfer, done: 0, total: 0, rows: 0, fraction: fraction)
      started = ContinuousClock.now
      complete = false
      wait = WaitDisplay()
      AccessibilityAnnouncement.post("アプリで使うデータを受け取っています。")
      ticker?.cancel()
      ticker = Task { [weak self] in
        while let self, self.step() {
          try? await Task.sleep(for: Self.tick)
        }
      }
    }
    let path = updatePath
    operation = Task { [weak self, sync, automatic] in
      guard let self else { return }
      do {
        // iOS terminates an app that it suspends while the transfer or the import holds its locks.
        let outcome = try await BackgroundTimeRunner.run(
          ApplicationBackgroundTime(), name: "synchronize"
        ) { [weak self] () async throws -> UpdateOutcome in
          let progress: @Sendable (SyncProgress) async -> Void = { [weak self] report in
            await MainActor.run { self?.receive(report, first: first) }
          }
          switch run {
          case .first:
            let saved = try await sync.synchronize(paths: .every, progress: progress)
            await automatic.recordPerson(transfer: nil, path: path)
            return UpdateOutcome(read: false, start: nil, manifest: saved)
          case .check: return try await automatic.check(path: path, progress: progress)
          case .path(let reported):
            return try await automatic.pathChanged(reported, progress: progress)
          case .person:
            let saved = try await automatic.runPerson(path: path, progress: progress)
            return UpdateOutcome(read: false, start: nil, manifest: saved)
          }
        }
        busy = false
        failures = 0
        if outcome.reply == .failed { problem = "データを新しくできませんでした。前のデータのまま使えます。" }
        guard let result = outcome.manifest else {
          if let manifest { try? BackgroundRefresh.schedule(manifest: manifest) }
          return
        }
        manifest = result
        complete = true
        await notifyExtensions(result)
        try? BackgroundRefresh.schedule(manifest: result)
      } catch is CancellationError {
        busy = false
        stopFirstDownload()
      } catch {
        busy = false
        fail(error, first: first)
      }
    }
  }

  private func receive(_ report: SyncProgress, first: Bool) {
    guard first else { return }
    fraction = max(fraction, report.fraction)
    // Each report arrives on its own task, so a late transfer report never moves the display back a stage.
    if report.stage >= latest.stage { latest = report }
  }

  /// Steps the display with the latest sample, and returns whether the display still needs time.
  private func step() -> Bool {
    guard let current = wait else { return false }
    let elapsed = started.duration(to: .now).components
    let now = Int(elapsed.seconds) * 1_000 + Int(elapsed.attoseconds / 1_000_000_000_000_000)
    let next = WaitDisplay.step(
      current,
      WaitInput(
        now: now, stage: latest.stage, done: latest.done, total: latest.total, rows: latest.rows,
        complete: complete, waiting: latest.waiting))
    if next != current {
      if next.line == .weakSignal && current.line != .weakSignal {
        AccessibilityAnnouncement.post("電波が弱いようです。つながると、続きから受け取ります。")
      }
      if next.finished && !current.finished {
        AccessibilityAnnouncement.post("準備ができました。")
      }
      wait = next
    }
    return !next.finished
  }

  private func stopFirstDownload() {
    ticker?.cancel()
    ticker = nil
    if manifest == nil { wait = nil }
  }

  /// A transfer that an automatic update kept off an expensive or constrained path waits again, and the path rule starts it later.
  private static func deferred(_ error: any Error) -> Bool {
    guard let error = error as? URLError else { return false }
    return error.networkUnavailableReason == .expensive
      || error.networkUnavailableReason == .constrained
  }

  private func fail(_ error: any Error, first: Bool) {
    if !first && Self.deferred(error) { return }
    failures += 1
    let delay = DownloadSchedule.retryDelay(afterFailures: failures)
    let reason: String?
    switch error {
    case ImportError.activationUncertain:
      reason = "データを受け取れたかを確かめられませんでした。アプリを開き直してください。"
    case ImportError.projectionTooLarge:
      reason = "一つの電話番号に集まる情報が多すぎるため、データを受け取れませんでした。"
    case ServiceError.unsupportedFormat:
      reason =
        manifest == nil
        ? "データの形式がこのアプリに合わないため、受け取れませんでした。アプリを新しくしてください。"
        : "データの形式がこのアプリに合わないため、新しくできませんでした。前のデータのまま使えます。アプリを新しくしてください。"
    default: reason = nil
    }
    guard manifest == nil else {
      // An automatic update keeps the saved data and says so in Settings without speaking.
      problem = reason ?? "データを新しくできませんでした。前のデータのまま使えます。"
      return
    }
    stopFirstDownload()
    stopped = reason ?? "\(Self.duration(delay))後に、自動でもう一度受け取ります。"
    AccessibilityAnnouncement.post("データの受け取りが止まりました。\(stopped ?? "")")
    scheduleRetry(after: delay)
  }

  private func scheduleRetry(after seconds: Int) {
    retry = Task { [weak self] in
      try? await Task.sleep(for: .seconds(seconds))
      guard !Task.isCancelled, let self else { return }
      self.retry = nil
      self.update(.first)
    }
  }

  static func duration(_ seconds: Int) -> String {
    seconds < 60 ? "\(seconds)秒" : "\((seconds + 59) / 60)分"
  }

  private func readExtensionStates() async {
    do {
      show(try await ExtensionOperations.callerEnabled() ? .on : .off)
    } catch { show(.unknown) }
  }

  private func show(_ status: CallerStatus) {
    #if DEBUG
      callerStatus = forcedCallerStatus ?? status
    #else
      callerStatus = status
    #endif
  }

  private func notifyExtensions(_ manifest: SnapshotManifest, force: Set<SnapshotConsumer> = [])
    async
  {
    // A directory saved before the caller file existed gets one before iOS asks the extension for it.
    do { try await store.ensureCallerFile(generation: manifest.generation) } catch {
      SystemTraceSink().record(TraceEvent(phase: .notification, outcome: .deferred))
    }
    let results = await ExtensionNotifications.refresh(
      generation: manifest.generation,
      notifier: NativeExtensionNotifier(), receipts: SavedGenerationReceipts(), force: force,
      trace: SystemTraceSink())
    for result in results {
      let status: CallerStatus
      switch result.state {
      case .disabled: status = .off
      case .current, .notified: status = .on
      case .failed(let reply): status = reply.status
      case .unavailable: status = .unknown
      }
      switch result.consumer {
      case .caller: show(status)
      }
    }
  }

  #if PHONEBOOK_VERIFICATION_TOOLS
    /// Runs a transfer that the person starts, on any path, or the first download before any data exists.
    func updateNow() {
      guard !busy else { return }
      update(manifest == nil ? .first : .person)
    }

    /// The update record, which the QA screen shows as check times.
    var updateRecord: UpdateRecord { DefaultsUpdateRecords().load() }

    /// Asks iOS to load the caller names again after the test number changes, and reports the state and the code that iOS gave.
    /// A load that is already running may hold the earlier test number, so the request waits for it and asks again a few times.
    func reloadCallerNames() async -> CallerReload {
      let enabled: Bool
      do { enabled = try await ExtensionOperations.callerEnabled() } catch {
        show(.unknown)
        return CallerReload(status: .unknown, code: (error as? CallDirectoryFailure)?.code)
      }
      guard enabled else {
        show(.off)
        return CallerReload(status: .off, code: nil)
      }
      var reply = CallerReply.other
      for attempt in 0..<Self.reloadAttempts {
        if attempt > 0 { try? await Task.sleep(for: Self.reloadSpacing) }
        do {
          try await ExtensionOperations.reloadCaller()
          reply = .loaded
        } catch {
          reply = (error as? CallDirectoryFailure).map { .callDirectory(code: $0.code) } ?? .other
        }
        guard reply.status == .loading else { break }
      }
      show(reply.status)
      if case .callDirectory(let code) = reply {
        return CallerReload(status: reply.status, code: code)
      }
      return CallerReload(status: reply.status, code: nil)
    }

    static let reloadAttempts = 4
    static let reloadSpacing = Duration.seconds(3)
  #endif

  func openCallerSettings() {
    CXCallDirectoryManager.sharedInstance.openSettings { [weak self] error in
      if error != nil {
        Task { @MainActor [weak self] in self?.problem = "iPhoneの設定を開けませんでした。" }
      }
    }
  }
}

enum AccessibilityAnnouncement {
  @MainActor static func post(_ text: String) {
    guard !text.isEmpty else { return }
    AccessibilityNotification.Announcement(text).post()
  }
}
