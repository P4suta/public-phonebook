import BackgroundTasks
import CallKit
import Foundation
import Network
import Observation
import PhonebookCore
import PhonebookKit
import SwiftUI

enum ExtensionOperations {
  static func callerEnabled() async throws -> Bool {
    try await withCheckedThrowingContinuation { continuation in
      CXCallDirectoryManager.sharedInstance.getEnabledStatusForExtension(
        withIdentifier: AppIdentity.callDirectory
      ) { status, error in
        if let error {
          continuation.resume(throwing: error)
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
        if let error { continuation.resume(throwing: error) } else { continuation.resume() }
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
  @ObservationIgnored private let api: APIClient
  @ObservationIgnored private let store: SnapshotStore
  @ObservationIgnored private let origin: String

  init(api: APIClient, store: SnapshotStore) {
    origin = api.origin.absoluteString
    self.api = api
    self.store = store
    sync = SyncEngine(api: api, store: store, trace: SystemTraceSink())
    monitor.pathUpdateHandler = { [weak self] path in
      let costly = path.isExpensive || path.isConstrained
      Task { @MainActor [weak self] in self?.costlyNetwork = costly }
    }
    monitor.start(queue: DispatchQueue(label: "network-path", qos: .utility))
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
    if manifest == nil { update(first: true) }
  }

  /// Reads the saved data, continues a first download that the person started, and runs a due monthly update.
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
      if requested { update(first: true) } else { await readDownloadSize() }
      return
    }
    try? BackgroundRefresh.schedule(manifest: manifest)
    // Monthly updates wait for a path that is neither expensive nor constrained.
    if !costlyPath, manifest.origin != origin || due(manifest) {
      BackgroundRefresh.lastAttempt = Date()
      update(first: false)
    }
  }

  private func readDownloadSize() async {
    guard downloadBytes == nil else { return }
    downloadBytes = try? await api.datasets().archive.bytes
  }

  private func due(_ manifest: SnapshotManifest) -> Bool {
    #if DEBUG
      if forcedDue {
        forcedDue = false
        return true
      }
    #endif
    return RefreshPolicy.nextDate(
      updatedAt: manifest.updatedAt, lastAttempt: BackgroundRefresh.lastAttempt) <= Date()
  }

  /// Runs the first download with its display and announcements, or a silent monthly update.
  private func update(first: Bool) {
    guard !busy else { return }
    retry?.cancel()
    retry = nil
    stopped = nil
    problem = nil
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
    operation = Task { [weak self, sync] in
      guard let self else { return }
      do {
        let result = try await sync.synchronize(paths: first ? .every : .inexpensive) {
          [weak self] report in
          await MainActor.run { self?.receive(report, first: first) }
        }
        manifest = result
        busy = false
        failures = 0
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
        complete: complete))
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

  /// A transfer that a monthly update kept off an expensive or constrained path waits for the next update.
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
      // A monthly update keeps the saved data and says so in Settings without speaking.
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
      self.update(first: true)
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
      case .failed: status = .onRetrying
      case .unavailable: status = .unknown
      }
      switch result.consumer {
      case .caller: show(status)
      }
    }
  }

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
