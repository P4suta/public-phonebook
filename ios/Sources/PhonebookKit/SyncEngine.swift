import Foundation
import PhonebookCore

public actor SyncEngine {
  /// Shares of the overall progress for downloading, saving records, and preparing numbers.
  static let downloadShare = 0.4
  static let saveShare = 0.55
  /// The part of the download share that a delta's own transfer takes before its rows are rebuilt.
  static let deltaTransferShare = 0.5

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

  /// Downloads the national directory, saves it as a new generation, and reports progress from 0 to 1.
  public func synchronize(progress: @escaping @Sendable (Double) async -> Void) async throws
    -> SnapshotManifest
  {
    guard !updating else { throw ImportError.alreadyUpdating }
    updating = true
    defer { updating = false }
    return try await TraceContext.$operation.withValue(UUID()) {
      try await perform(progress: progress)
    }
  }

  private func perform(progress: @escaping @Sendable (Double) async -> Void) async throws
    -> SnapshotManifest
  {
    trace.record(TraceEvent(phase: .discovery, outcome: .started))
    let listing = try await api.datasets()
    let archive = listing.archive
    let snapshot = archive.snapshot
    trace.record(TraceEvent(phase: .discovery, outcome: .completed, snapshot: snapshot))
    await progress(0)
    if let link = listing.deltas,
      try await stageDelta(link: link, archive: archive, progress: progress)
    {
      return try await activate(snapshot: snapshot, progress: progress)
    }
    let file = try await api.download(archive) { fraction in
      Task { await progress(min(max(fraction, 0), 1) * Self.downloadShare) }
    }
    defer { try? FileManager.default.removeItem(at: file) }
    try await stage(
      DirectoryArchiveReader(url: file, trace: trace), archive: archive, progress: progress)
    return try await activate(snapshot: snapshot, progress: progress)
  }

  /// Stages the listed delta from the saved snapshot, and returns false when the complete archive is needed instead.
  private func stageDelta(
    link: String, archive: DatasetArchive, progress: @escaping @Sendable (Double) async -> Void
  ) async throws -> Bool {
    let saved: SnapshotManifest?
    do { saved = try await store.manifest() } catch {
      trace.record(TraceEvent(phase: .delta, outcome: .deferred, snapshot: archive.snapshot))
      return false
    }
    guard let saved, saved.snapshot != archive.snapshot else { return false }
    trace.record(TraceEvent(phase: .delta, outcome: .started, snapshot: archive.snapshot))
    do {
      let deltas = try await api.directoryDeltas(link: link)
      guard
        let delta = deltas.first(where: { $0.base == saved.snapshot }),
        delta.snapshot == archive.snapshot, delta.archiveSha256 == archive.sha256
      else {
        trace.record(TraceEvent(phase: .delta, outcome: .deferred, snapshot: archive.snapshot))
        return false
      }
      let base = try await DeltaBase(store: store, manifest: saved)
      let transfer = Self.downloadShare * Self.deltaTransferShare
      let file = try await api.download(delta) { fraction in
        Task { await progress(min(max(fraction, 0), 1) * transfer) }
      }
      defer { try? FileManager.default.removeItem(at: file) }
      let rebuilt = FileManager.default.temporaryDirectory.appendingPathComponent(
        UUID().uuidString)
      defer { try? FileManager.default.removeItem(at: rebuilt) }
      let admission = try await DirectoryDeltaApplier(url: file, delta: delta).rebuild(
        from: base, into: rebuilt
      ) { fraction in
        await progress(transfer + min(max(fraction, 0), 1) * (Self.downloadShare - transfer))
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
    progress: @escaping @Sendable (Double) async -> Void
  ) async throws {
    var saved = 0
    func report(_ rows: Int) async {
      saved += rows
      let fraction = min(Double(saved) / Double(max(archive.contacts, 1)), 1)
      await progress(Self.downloadShare + fraction * Self.saveShare)
    }
    do {
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
            if let rows = try await saving.next() { await report(rows) }
            try Task.checkCancellation()
            saving.addTask { [store] in
              try await store.append(records)
              return records.count
            }
          })
        while let rows = try await saving.next() { await report(rows) }
      }
      trace.record(TraceEvent(phase: .decode, outcome: .completed, snapshot: archive.snapshot))
      await progress(Self.downloadShare + Self.saveShare)
    } catch {
      try await discard(after: error, snapshot: archive.snapshot)
    }
  }

  private func activate(
    snapshot: SnapshotID, progress: @escaping @Sendable (Double) async -> Void
  ) async throws -> SnapshotManifest {
    do {
      try Task.checkCancellation()
      let manifest = try await store.publish(at: now())
      await progress(1)
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
