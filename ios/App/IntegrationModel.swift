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
  var problem: String?
  var busy: Bool { progress != nil }
  private var refreshing = false
  @ObservationIgnored private var operation: Task<Void, Never>?
  @ObservationIgnored private let sync: SyncEngine
  @ObservationIgnored private let store: SnapshotStore
  @ObservationIgnored private let origin: String

  init(api: APIClient, store: SnapshotStore) {
    origin = api.origin.absoluteString
    self.store = store
    sync = SyncEngine(api: api, store: store, trace: SystemTraceSink())
  }

  var percent: Int { Int(((progress ?? 0) * 100).rounded(.down)) }

  func refresh() async {
    guard !refreshing else { return }
    refreshing = true
    defer { refreshing = false }
    if progress == nil {
      do { manifest = try await store.manifest() } catch {
        problem = "保存したデータを開けませんでした。データを保存し直してください。"
      }
    }
    if let manifest, progress == nil {
      await notifyExtensions(manifest)
    } else {
      await readExtensionStates()
    }
    guard let manifest else { return }
    try? BackgroundRefresh.schedule(manifest: manifest)
    if manifest.origin != origin {
      problem = "接続先が変わりました。データを更新してください。"
    } else if !busy,
      RefreshPolicy.nextDate(
        updatedAt: manifest.updatedAt, lastAttempt: BackgroundRefresh.lastAttempt) <= Date()
    {
      BackgroundRefresh.lastAttempt = Date()
      update()
    }
  }

  func update() {
    guard progress == nil else { return }
    problem = nil
    progress = 0
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
        AccessibilityAnnouncement.post("全国の電話番号を保存しました。")
        await notifyExtensions(result)
        try? BackgroundRefresh.schedule(manifest: result)
      } catch is CancellationError {
        progress = nil
      } catch {
        progress = nil
        switch error {
        case ImportError.activationUncertain:
          problem = "保存できたかを確認できませんでした。アプリを開き直してください。"
        case ImportError.projectionTooLarge:
          problem = "一つの電話番号に集まる情報が多すぎるため、保存できませんでした。"
        default:
          problem =
            manifest == nil
            ? "全国の電話番号を保存できませんでした。インターネットにつながっているかを確かめてください。"
            : "データを更新できませんでした。前に保存したデータで使えます。"
        }
        AccessibilityAnnouncement.post(problem ?? "")
      }
    }
  }

  func cancel() { operation?.cancel() }

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
