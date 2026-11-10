import Foundation
import PhonebookCore
import Synchronization

/// What the app keeps between update checks, including after iOS ends the process.
public struct UpdateRecord: Codable, Sendable, Equatable {
  public var state: UpdateState
  public var etag: String?
  /// The body of the last answered listing, which a waiting transfer uses without a second read.
  public var listing: Data?

  public init(state: UpdateState = UpdateState(), etag: String? = nil, listing: Data? = nil) {
    self.state = state
    self.etag = etag
    self.listing = listing
  }
}

public protocol UpdateRecordStore: Sendable {
  func load() -> UpdateRecord
  func save(_ record: UpdateRecord)
}

/// Keeps the record in memory, for tests and previews.
public final class MemoryUpdateRecords: UpdateRecordStore {
  private let record: Mutex<UpdateRecord>
  public init(_ record: UpdateRecord = UpdateRecord()) { self.record = Mutex(record) }
  public func load() -> UpdateRecord { record.withLock { $0 } }
  public func save(_ record: UpdateRecord) { self.record.withLock { $0 = record } }
}

/// The outcome of one update event: whether the listing answered, which transfer started, and the generation it saved.
public struct UpdateOutcome: Sendable {
  public let read: Bool
  public let start: UpdateStart?
  public let manifest: SnapshotManifest?
  /// What the listing answered when the event read it, or nil when it read nothing.
  public let reply: ListingReply?

  public init(
    read: Bool, start: UpdateStart?, manifest: SnapshotManifest?, reply: ListingReply? = nil
  ) {
    self.read = read
    self.start = start
    self.manifest = manifest
    self.reply = reply
  }
}

/// Runs the daily check and the transfers that `UpdateCheck` starts, and records each step.
public actor AutomaticUpdate {
  private let api: APIClient
  private let sync: SyncEngine
  private let store: SnapshotStore
  private let records: any UpdateRecordStore
  private let now: @Sendable () -> Date

  public init(
    api: APIClient, sync: SyncEngine, store: SnapshotStore, records: any UpdateRecordStore,
    now: @escaping @Sendable () -> Date = Date.init
  ) {
    self.api = api
    self.sync = sync
    self.store = store
    self.records = records
    self.now = now
  }

  /// The seconds that the decision counts in.
  private var seconds: Int { Int(now().timeIntervalSince1970.rounded(.down)) }

  /// A launch, a return to the foreground, or a background task on `path`.
  /// The check reads the listing only when the decision finds it due, and sends the saved ETag.
  public func check(
    path: UpdatePath, progress: @escaping @Sendable (SyncProgress) async -> Void = { _ in }
  ) async throws -> UpdateOutcome {
    var record = records.load()
    let now = seconds
    guard UpdateCheck.due(record.state, now: now) else {
      return UpdateOutcome(read: false, start: nil, manifest: nil)
    }
    let reply: ListingReply
    do {
      switch try await api.datasets(etag: record.etag) {
      case .notModified: reply = .notModified
      case .listed(let listing, let etag, let body):
        record.etag = etag
        record.listing = body
        reply = try await classify(listing)
      }
    } catch {
      if Task.isCancelled || error is CancellationError { throw CancellationError() }
      reply = .failed
    }
    let outcome = try await apply(
      .check(now: now, reply: reply, path: path), to: record, progress)
    return UpdateOutcome(
      read: outcome.read, start: outcome.start, manifest: outcome.manifest, reply: reply)
  }

  /// iOS reports a path, which starts a waiting transfer when it is neither expensive nor constrained.
  public func pathChanged(
    _ path: UpdatePath, progress: @escaping @Sendable (SyncProgress) async -> Void = { _ in }
  ) async throws -> UpdateOutcome {
    try await apply(.path(path), to: records.load(), progress)
  }

  /// Runs a transfer that the person started, which may use every path, and records the answered read it made.
  public func runPerson(
    path: UpdatePath, progress: @escaping @Sendable (SyncProgress) async -> Void = { _ in }
  ) async throws -> SnapshotManifest {
    let manifest = try await sync.synchronize(paths: .every, progress: progress)
    recordPerson(transfer: nil, path: path)
    return manifest
  }

  /// Records a run that the person started after its listing answered, such as the first run.
  public func recordPerson(transfer: UpdateTransfer?, path: UpdatePath) {
    var record = records.load()
    record.state =
      UpdateCheck.step(
        record.state, .person(now: seconds, transfer: transfer, path: path)
      ).state
    record.etag = nil
    record.listing = nil
    records.save(record)
  }

  /// Names what an answered listing means for the saved snapshot.
  private func classify(_ listing: DatasetListing) async throws -> ListingReply {
    guard let saved = try await store.manifest() else { return .archive }
    if saved.snapshot == listing.archive.snapshot { return .saved }
    guard let link = listing.deltas,
      let deltas = try? await api.directoryDeltas(link: link),
      deltas.contains(where: {
        $0.base == saved.snapshot && $0.snapshot == listing.archive.snapshot
          && $0.archiveSha256 == listing.archive.sha256
      })
    else { return .archive }
    return .delta
  }

  /// Takes one decision step, saves it, and runs the automatic transfer that it starts on paths that are neither expensive nor constrained.
  private func apply(
    _ event: UpdateEvent, to record: UpdateRecord,
    _ progress: @escaping @Sendable (SyncProgress) async -> Void
  ) async throws -> UpdateOutcome {
    var record = record
    let step = UpdateCheck.step(record.state, event)
    record.state = step.state
    records.save(record)
    guard let start = step.start else {
      return UpdateOutcome(read: step.read, start: nil, manifest: nil)
    }
    do {
      // Every check that leaves a transfer waiting keeps the body it answered with, so the listing is read again only after a lost record.
      let manifest =
        if let body = record.listing {
          try await sync.synchronize(
            listing: api.listing(from: body), paths: .inexpensive, progress: progress)
        } else {
          try await sync.synchronize(paths: .inexpensive, progress: progress)
        }
      return UpdateOutcome(read: step.read, start: start, manifest: manifest)
    } catch {
      // A started transfer that fails waits again, and the decision's path rule still governs its next start.
      var failed = records.load()
      failed.state.waiting = start.transfer
      records.save(failed)
      throw error
    }
  }
}
