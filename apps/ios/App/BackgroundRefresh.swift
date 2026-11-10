import BackgroundTasks
import Foundation
import Network
import PhonebookCore
import PhonebookKit
import os

/// Keeps the update record in the app's defaults, so a background task in a new process continues the same decision.
struct DefaultsUpdateRecords: UpdateRecordStore {
  private static let key = "automaticUpdate"

  func load() -> UpdateRecord {
    UserDefaults.standard.data(forKey: Self.key).flatMap {
      try? JSONDecoder().decode(UpdateRecord.self, from: $0)
    } ?? UpdateRecord()
  }

  func save(_ record: UpdateRecord) {
    UserDefaults.standard.set(try? JSONEncoder().encode(record), forKey: Self.key)
  }
}

/// Reads the current path once, which a background task needs before it decides.
enum CurrentPath {
  static func read() async -> UpdatePath {
    await withCheckedContinuation { continuation in
      let monitor = NWPathMonitor()
      // The monitor may report again before its cancellation takes hold, and a continuation resumes once.
      let reported = OSAllocatedUnfairLock(initialState: false)
      monitor.pathUpdateHandler = { path in
        guard
          reported.withLock({ done in
            defer { done = true }
            return !done
          })
        else { return }
        monitor.cancel()
        continuation.resume(
          returning: UpdatePath(expensive: path.isExpensive, constrained: path.isConstrained))
      }
      monitor.start(queue: DispatchQueue(label: "background-path", qos: .utility))
    }
  }
}

enum BackgroundRefresh {
  /// The processing task, which performs a waiting transfer and its import.
  static var identifier: String { AppIdentity.backgroundRefresh }
  /// The app refresh task, which makes the daily check.
  static var checkIdentifier: String { AppIdentity.backgroundCheck }

  static func automatic(api: APIClient, store: SnapshotStore) -> AutomaticUpdate {
    AutomaticUpdate(
      api: api, sync: AppIdentity.synchronizer(api: api, store: store), store: store,
      records: DefaultsUpdateRecords())
  }

  static func register() {
    BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
      let request = BackgroundRequest(task: task, transfers: true)
      let operation = Task { await request.run() }
      task.expirationHandler = { operation.cancel() }
    }
    BGTaskScheduler.shared.register(forTaskWithIdentifier: checkIdentifier, using: nil) { task in
      let request = BackgroundRequest(task: task, transfers: false)
      let operation = Task { await request.run() }
      task.expirationHandler = { operation.cancel() }
    }
  }

  /// Schedules the daily check a day after the last answered read, and the processing task a month after the saved snapshot was generated or at once for a waiting transfer.
  static func schedule(manifest: SnapshotManifest?) throws {
    guard let manifest,
      manifest.origin == URL(string: AppIdentity.apiOrigin)?.absoluteString
    else {
      BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
      BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: checkIdentifier)
      return
    }
    let state = DefaultsUpdateRecords().load().state
    let check = BGAppRefreshTaskRequest(identifier: checkIdentifier)
    check.earliestBeginDate = state.answeredAt.map {
      Date(timeIntervalSince1970: TimeInterval($0 + UpdateCheck.intervalSeconds))
    }
    let processing = BGProcessingTaskRequest(identifier: identifier)
    processing.requiresNetworkConnectivity = true
    processing.earliestBeginDate =
      state.waiting == nil
      ? RefreshPolicy.nextDate(
        generatedAt: manifest.generatedAt, savedAt: manifest.updatedAt, lastAttempt: nil)
      : nil
    do {
      try BGTaskScheduler.shared.submit(check)
      try BGTaskScheduler.shared.submit(processing)
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
  /// The processing task transfers, and the app refresh task leaves a transfer waiting for it.
  private let transfers: Bool

  init(task: BGTask, transfers: Bool) {
    self.task = task
    self.transfers = transfers
  }

  func run() async {
    var success = false
    defer { task.setTaskCompleted(success: success) }
    do {
      let store = try AppIdentity.store()
      guard let manifest = try await AppIdentity.manifest(in: store) else {
        throw ImportError.unavailableStorage
      }
      guard let origin = URL(string: AppIdentity.apiOrigin) else { throw ServiceError.invalidURL }
      guard manifest.origin == origin.absoluteString else {
        try BackgroundRefresh.schedule(manifest: manifest)
        success = true
        return
      }
      let api = try APIClient(origin: origin, trace: SystemTraceSink())
      let automatic = BackgroundRefresh.automatic(api: api, store: store)
      let path = await CurrentPath.read()
      // The app refresh task checks on a path that it reports as expensive, so its transfer waits for the processing task.
      let checkPath = transfers ? path : UpdatePath(expensive: true, constrained: path.constrained)
      var outcome = try await automatic.check(path: checkPath)
      if transfers, outcome.manifest == nil {
        outcome = try await automatic.pathChanged(path)
      }
      if let result = outcome.manifest {
        try await store.ensureCallerFile(generation: result.generation)
        _ = await ExtensionNotifications.refresh(
          generation: result.generation,
          notifier: NativeExtensionNotifier(), receipts: SavedGenerationReceipts(),
          trace: SystemTraceSink())
      }
      success = true
      try BackgroundRefresh.schedule(manifest: outcome.manifest ?? manifest)
    } catch {
      do {
        let store = try AppIdentity.store()
        try await BackgroundRefresh.schedule(manifest: AppIdentity.manifest(in: store))
      } catch { SystemTraceSink().record(TraceEvent(phase: .schedule, outcome: .deferred)) }
    }
  }
}
