import BackgroundTasks
import Foundation
import PhonebookKit

enum BackgroundRefresh {
  static var identifier: String { AppIdentity.backgroundRefresh }
  static var lastAttempt: Date? {
    get { UserDefaults.standard.object(forKey: "automaticAttempt") as? Date }
    set { UserDefaults.standard.set(newValue, forKey: "automaticAttempt") }
  }

  static func register() {
    BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
      let request = BackgroundRequest(task: task)
      let operation = Task { await request.run() }
      task.expirationHandler = { operation.cancel() }
    }
  }

  static func schedule(manifest: SnapshotManifest?) throws {
    guard let manifest,
      manifest.origin == URL(string: AppIdentity.apiOrigin)?.absoluteString
    else {
      BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
      return
    }
    let request = BGProcessingTaskRequest(identifier: identifier)
    request.requiresNetworkConnectivity = true
    request.earliestBeginDate = RefreshPolicy.nextDate(
      updatedAt: manifest.updatedAt, lastAttempt: lastAttempt)
    do {
      try BGTaskScheduler.shared.submit(request)
      SystemTraceSink().record(TraceEvent(phase: .schedule, outcome: .completed))
    } catch {
      SystemTraceSink().record(TraceEvent(phase: .schedule, outcome: .deferred))
      throw error
    }
  }
}

// Apple owns the task's completion and expiration synchronization.
private final class BackgroundRequest: @unchecked Sendable {
  private let task: BGTask
  init(task: BGTask) { self.task = task }

  func run() async {
    var success = false
    defer { task.setTaskCompleted(success: success) }
    do {
      let store = try AppIdentity.store()
      guard let manifest = try await store.manifest() else { throw ImportError.unavailableStorage }
      guard let origin = URL(string: AppIdentity.apiOrigin) else { throw ServiceError.invalidURL }
      guard manifest.origin == origin.absoluteString,
        RefreshPolicy.nextDate(
          updatedAt: manifest.updatedAt, lastAttempt: BackgroundRefresh.lastAttempt) <= Date()
      else {
        try BackgroundRefresh.schedule(manifest: manifest)
        success = true
        return
      }
      BackgroundRefresh.lastAttempt = Date()
      let api = try APIClient(origin: origin, trace: SystemTraceSink())
      let result = try await SyncEngine(api: api, store: store, trace: SystemTraceSink())
        .synchronize(progress: { _ in })
      _ = await ExtensionNotifications.refresh(
        generation: result.generation,
        notifier: NativeExtensionNotifier(), receipts: SavedGenerationReceipts(),
        trace: SystemTraceSink())
      success = true
      try BackgroundRefresh.schedule(manifest: result)
    } catch {
      do {
        let store = try AppIdentity.store()
        try await BackgroundRefresh.schedule(manifest: store.manifest())
      } catch { SystemTraceSink().record(TraceEvent(phase: .schedule, outcome: .deferred)) }
    }
  }
}
