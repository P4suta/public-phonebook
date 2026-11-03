import Foundation
import PhonebookCore

/// One progress report of a synchronization, in the stages that the first download's steps name.
public struct SyncProgress: Sendable, Equatable {
  /// Receiving the file, preparing the search, and preparing caller names, counted from 0.
  public let stage: Int
  /// Bytes received in this attempt or rows saved, out of `total` for this stage.
  public let done: Int
  public let total: Int
  /// The rows of the archive, which size the work after the transfer.
  public let rows: Int
  /// The share of the whole run from 0 to 1, counting bytes kept from earlier attempts.
  public let fraction: Double

  public init(stage: Int, done: Int, total: Int, rows: Int, fraction: Double) {
    self.stage = stage
    self.done = done
    self.total = total
    self.rows = rows
    self.fraction = fraction
  }

  public static let transfer = 0
  public static let prepare = 1
  public static let identify = 2
}

public actor SyncEngine {
  /// Shares of the overall progress for downloading, saving records, and preparing numbers.
  static let downloadShare = 0.4
  static let saveShare = 0.55
  /// The part of the download share that a delta's own transfer takes before its rows are rebuilt.
  static let deltaTransferShare = 0.5
  /// The rebuild of a delta reports its share in thousandths.
  static let rebuildSteps = 1_000

  private let api: APIClient
  private let store: SnapshotStore
  private let now: @Sendable () -> Date
  private let trace: any TraceSink
  private var updating = false

  public init(
    api: APIClient, store: SnapshotStore, now: @escaping @Sendable () -> Date = Date.init,
    trace: any TraceSink = DiscardingTraceSink()
  ) {
    self.api = api
    self.store = store
    self.now = now
    self.trace = trace
  }

  /// Downloads the national directory over the given paths, saves it as a new generation, and reports each stage.
  /// The received bytes stay in the store's transfer directory until the new generation activates, so a later attempt resumes them.
  public func synchronize(
    paths: NetworkPaths = .every, progress: @escaping @Sendable (SyncProgress) async -> Void
  ) async throws -> SnapshotManifest {
    guard !updating else { throw ImportError.alreadyUpdating }
    updating = true
    defer { updating = false }
    return try await TraceContext.$operation.withValue(UUID()) {
      try await perform(paths: paths, progress: progress)
    }
  }

  private func perform(
    paths: NetworkPaths, progress: @escaping @Sendable (SyncProgress) async -> Void
  ) async throws -> SnapshotManifest {
    trace.record(TraceEvent(phase: .discovery, outcome: .started))
    let listing = try await api.datasets(paths: paths)
    let archive = listing.archive
    let snapshot = archive.snapshot
    let rows = archive.contacts
    trace.record(TraceEvent(phase: .discovery, outcome: .completed, snapshot: snapshot))
    await progress(
      SyncProgress(stage: SyncProgress.transfer, done: 0, total: 0, rows: rows, fraction: 0))
    if let link = listing.deltas,
      try await stageDelta(link: link, archive: archive, paths: paths, progress: progress)
    {
      return try await activate(snapshot: snapshot, rows: rows, progress: progress)
    }
    let file = try await api.download(archive, paths: paths, partials: store.transfers) { part in
      Task {
        await progress(
          SyncProgress(
            stage: SyncProgress.transfer, done: part.received, total: part.total - part.resumed,
            rows: rows,
            fraction: Double(part.resumed + part.received) / Double(max(part.total, 1))
              * Self.downloadShare))
      }
    }
    try await stage(
      DirectoryArchiveReader(url: file, trace: trace), archive: archive, progress: progress)
    let manifest = try await activate(snapshot: snapshot, rows: rows, progress: progress)
    try? FileManager.default.removeItem(at: file)
    return manifest
  }

  /// Stages the listed delta from the saved snapshot, and returns false when the complete archive is needed instead.
  private func stageDelta(
    link: String, archive: DatasetArchive, paths: NetworkPaths,
    progress: @escaping @Sendable (SyncProgress) async -> Void
  ) async throws -> Bool {
    let saved: SnapshotManifest?
    do { saved = try await store.manifest() } catch {
      trace.record(TraceEvent(phase: .delta, outcome: .deferred, snapshot: archive.snapshot))
      return false
    }
    guard let saved, saved.snapshot != archive.snapshot else { return false }
    trace.record(TraceEvent(phase: .delta, outcome: .started, snapshot: archive.snapshot))
    do {
      let deltas = try await api.directoryDeltas(link: link, paths: paths)
      guard
        let delta = deltas.first(where: { $0.base == saved.snapshot }),
        delta.snapshot == archive.snapshot, delta.archiveSha256 == archive.sha256
      else {
        trace.record(TraceEvent(phase: .delta, outcome: .deferred, snapshot: archive.snapshot))
        return false
      }
      let base = try await DeltaBase(store: store, manifest: saved)
      let transfer = Self.downloadShare * Self.deltaTransferShare
      let rows = archive.contacts
      let file = try await api.download(delta, paths: paths, partials: store.transfers) { part in
        Task {
          await progress(
            SyncProgress(
              stage: SyncProgress.transfer, done: part.received, total: part.total - part.resumed,
              rows: rows,
              fraction: Double(part.resumed + part.received) / Double(max(part.total, 1))
                * transfer))
        }
      }
      defer { try? FileManager.default.removeItem(at: file) }
      let rebuilt = FileManager.default.temporaryDirectory.appendingPathComponent(
        UUID().uuidString)
      defer { try? FileManager.default.removeItem(at: rebuilt) }
      let admission = try await DirectoryDeltaApplier(url: file, delta: delta).rebuild(
        from: base, into: rebuilt
      ) { fraction in
        let share = min(max(fraction, 0), 1)
        await progress(
          SyncProgress(
            stage: SyncProgress.transfer, done: Int(share * Double(Self.rebuildSteps)),
            total: Self.rebuildSteps, rows: rows,
            fraction: transfer + share * (Self.downloadShare - transfer)))
      }
      guard admission == .apply else { throw DeltaRejection(admission: admission) }
      try await stage(
        DirectoryArchiveReader(url: rebuilt, encoding: .plain, trace: trace), archive: archive,
        progress: progress)
      trace.record(TraceEvent(phase: .delta, outcome: .completed, snapshot: archive.snapshot))
      return true
    } catch {
      if Task.isCancelled { throw CancellationError() }
      trace.record(TraceEvent(phase: .delta, outcome: .rejected, snapshot: archive.snapshot))
      return false
    }
  }

  /// Validates an archive into a new generation, and removes that generation when the archive fails.
  /// The store saves one batch while the reader parses the next, and saves the batches in archive order.
  /// The saved share of the progress follows the rows saved out of the archive's contact count.
  private func stage(
    _ reader: DirectoryArchiveReader, archive: DatasetArchive,
    progress: @escaping @Sendable (SyncProgress) async -> Void
  ) async throws {
    var saved = 0
    let rows = archive.contacts
    func report(_ batch: Int) async {
      saved += batch
      let fraction = min(Double(saved) / Double(max(rows, 1)), 1)
      await progress(
        SyncProgress(
          stage: SyncProgress.prepare, done: saved, total: rows, rows: rows,
          fraction: Self.downloadShare + fraction * Self.saveShare))
    }
    do {
      await progress(
        SyncProgress(
          stage: SyncProgress.prepare, done: 0, total: rows, rows: rows,
          fraction: Self.downloadShare))
      try await withThrowingTaskGroup(of: Int.self) { saving in
        _ = try await reader.read(
          header: { header in
            guard header.snapshot == archive.snapshot, header.contacts == archive.contacts else {
              throw ImportError.invalidSnapshot
            }
            try await store.begin(header: header, origin: api.origin)
          },
          records: { records, _ in
            // Waiting for the batch in flight keeps the saves in order and holds two batches at most.
            if let batch = try await saving.next() { await report(batch) }
            try Task.checkCancellation()
            saving.addTask { [store] in
              try await store.append(records)
              return records.count
            }
          })
        while let batch = try await saving.next() { await report(batch) }
      }
      trace.record(TraceEvent(phase: .decode, outcome: .completed, snapshot: archive.snapshot))
      await progress(
        SyncProgress(
          stage: SyncProgress.identify, done: 0, total: 1, rows: rows,
          fraction: Self.downloadShare + Self.saveShare))
    } catch {
      try await discard(after: error, snapshot: archive.snapshot)
    }
  }

  private func activate(
    snapshot: SnapshotID, rows: Int, progress: @escaping @Sendable (SyncProgress) async -> Void
  ) async throws -> SnapshotManifest {
    do {
      try Task.checkCancellation()
      let manifest = try await store.publish(at: now())
      await progress(
        SyncProgress(stage: SyncProgress.identify, done: 1, total: 1, rows: rows, fraction: 1))
      return manifest
    } catch {
      try await discard(after: error, snapshot: snapshot)
    }
  }

  private func discard(after error: any Error, snapshot: SnapshotID) async throws -> Never {
    trace.record(
      TraceEvent(
        phase: .stage, outcome: error is CancellationError ? .cancelled : .rejected,
        snapshot: snapshot))
    do { try await store.abort() } catch let cleanupError {
      throw SyncFailure(primary: error, cleanup: cleanupError)
    }
    throw error
  }
}

public struct SyncFailure: Error, Sendable {
  public let primary: any Error
  public let cleanup: any Error
}
