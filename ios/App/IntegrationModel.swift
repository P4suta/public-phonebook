import BackgroundTasks
import CallKit
import Foundation
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
  var manifest: SnapshotManifest?
  var callerEnabled = false
  var callerState = "確認しています"
  /// The saved share of an update from 0 to 1, or `nil` when no update runs.
  private(set) var progress: Double?
  /// When the running download started, for its remaining-time estimate.
  private(set) var startedAt: Date?
  var problem: String?
  var busy: Bool { progress != nil }
  private var refreshing = false
  @ObservationIgnored private var operation: Task<Void, Never>?
  @ObservationIgnored private var retry: Task<Void, Never>?
  @ObservationIgnored private var failures = 0
  #if DEBUG
    /// Lets a UI scenario make the saved data due once without waiting a month.
    @ObservationIgnored private var forcedDue =
      ProcessInfo.processInfo.environment["PHONEBOOK_REFRESH_DUE"] == "1"
  #endif
  @ObservationIgnored private let sync: SyncEngine
  @ObservationIgnored private let store: SnapshotStore
  @ObservationIgnored private let origin: String

  init(api: APIClient, store: SnapshotStore) {
    origin = api.origin.absoluteString
    self.store = store
    sync = SyncEngine(api: api, store: store, trace: SystemTraceSink())
  }

  var percent: Int { Int(((progress ?? 0) * 100).rounded(.down)) }

  /// Seconds left in the running download, or nil before the estimate has enough data.
  var remainingSeconds: Int? {
    guard let progress, let startedAt else { return nil }
    return DownloadSchedule.remainingSeconds(
      fraction: progress, elapsed: Date().timeIntervalSince(startedAt))
  }

  /// Reads the saved data and starts any download that is due, so no screen needs a download button.
  func refresh() async {
    guard !refreshing else { return }
    refreshing = true
    defer { refreshing = false }
    if progress == nil {
      do { manifest = try await store.manifest() } catch {
        manifest = nil
        problem = "アプリのデータを開けなかったので、受け取り直します。"
      }
    }
    if let manifest, progress == nil {
      await notifyExtensions(manifest)
    } else {
      await readExtensionStates()
    }
    guard !busy else { return }
    guard let manifest else {
      // The first download starts on its own, and returning to the app retries a failed one now.
      update()
      return
    }
    try? BackgroundRefresh.schedule(manifest: manifest)
    if manifest.origin != origin || due(manifest) {
      BackgroundRefresh.lastAttempt = Date()
      update()
    }
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

  private func update() {
    guard progress == nil else { return }
    retry?.cancel()
    retry = nil
    problem = nil
    progress = 0
    startedAt = Date()
    operation = Task { [weak self, sync] in
      guard let self else { return }
      do {
        let result = try await sync.synchronize { [weak self] value in
          await MainActor.run {
            guard let self, let current = self.progress else { return }
            self.progress = max(current, value)
          }
        }
        manifest = result
        progress = nil
        startedAt = nil
        failures = 0
        AccessibilityAnnouncement.post("アプリで使うデータを受け取りました。")
        await notifyExtensions(result)
        try? BackgroundRefresh.schedule(manifest: result)
      } catch is CancellationError {
        progress = nil
        startedAt = nil
      } catch {
        progress = nil
        startedAt = nil
        failures += 1
        let delay = DownloadSchedule.retryDelay(afterFailures: failures)
        switch error {
        case ImportError.activationUncertain:
          problem = "データを受け取れたかを確かめられませんでした。アプリを開き直してください。"
        case ImportError.projectionTooLarge:
          problem = "一つの電話番号に集まる情報が多すぎるため、データを受け取れませんでした。"
        default:
          problem =
            manifest == nil
            ? "データを受け取れませんでした。\(Self.duration(delay))後に、自動でもう一度受け取ります。"
            : "データを新しくできませんでした。前のデータのまま使えます。"
        }
        AccessibilityAnnouncement.post(problem ?? "")
        // Saved data stays usable, so only a missing first download retries on a timer.
        if manifest == nil { scheduleRetry(after: delay) }
      }
    }
  }

  private func scheduleRetry(after seconds: Int) {
    retry = Task { [weak self] in
      try? await Task.sleep(for: .seconds(seconds))
      guard !Task.isCancelled, let self else { return }
      self.retry = nil
      self.update()
    }
  }

  static func duration(_ seconds: Int) -> String {
    seconds < 60 ? "\(seconds)秒" : "\((seconds + 59) / 60)分"
  }

  private func readExtensionStates() async {
    do {
      callerEnabled = try await ExtensionOperations.callerEnabled()
      callerState = callerEnabled ? "オン" : "オフ"
    } catch { callerState = "確認できません" }
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
      let enabled = [.current, .notified, .failed].contains(result.state)
      let state: String
      switch result.state {
      case .disabled: state = "オフ"
      case .current, .notified: state = "オン"
      case .failed: state = "オン・反映できませんでした。次に開いたときにやり直します"
      case .unavailable: state = "このiPhoneでは使えません"
      }
      switch result.consumer {
      case .caller:
        callerState = state
        callerEnabled = enabled
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
