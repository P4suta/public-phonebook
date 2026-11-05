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
  /// The transfer waits for a network connection.
  public let waiting: Bool

  public init(
    stage: Int, done: Int, total: Int, rows: Int, fraction: Double, waiting: Bool = false
  ) {
    self.stage = stage
    self.done = done
    self.total = total
    self.rows = rows
    self.fraction = fraction
    self.waiting = waiting
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
  private let searchArtifacts: (any SearchArtifactSource)?
  /// Holds the decoded base and the rebuilt archive of a delta, which leave with their run.
  private let temporaryDirectory: URL
  private var updating = false

  public init(
    api: APIClient, store: SnapshotStore, now: @escaping @Sendable () -> Date = Date.init,
    trace: any TraceSink = DiscardingTraceSink(),
    temporaryDirectory: URL = FileManager.default.temporaryDirectory,
    searchArtifacts: (any SearchArtifactSource)? = nil
  ) {
    self.api = api
    self.store = store
    self.now = now
    self.trace = trace
    self.temporaryDirectory = temporaryDirectory
    self.searchArtifacts = searchArtifacts
  }

  /// Reads the listing and plans a first run from `bundle`, so the welcome notice names what the run receives.
  /// A failed listing plans with an unreachable listing, and only cancellation throws.
  public func planFirstRun(bundle: BundledDataset?, paths: NetworkPaths = .every) async throws
    -> FirstRunPlan
  {
    guard let bundle else {
      do {
        let archive = try await api.datasets(paths: paths).archive
        let extra =
          try await searchArtifacts?.transferBytes(
            snapshot: archive.snapshot, contacts: archive.contacts, paths: paths) ?? 0
        return FirstRunPlan.decide(
          bundle: .missing, listing: .noDeltaFromBundled(archiveBytes: archive.bytes + extra))
      } catch {
        if Task.isCancelled || error is CancellationError { throw CancellationError() }
        return FirstRunPlan.decide(bundle: .missing, listing: .unreachable)
      }
    }
    return try await discover(bundle: bundle, paths: paths).plan
  }

  /// Saves the first directory from `bundle` and the listing, as `FirstRunPlan` decides.
  /// Without a bundle the run downloads the complete archive, and any failure throws as it does today.
  /// With a bundle, a failed listing, transfer, rebuild, or check saves the bundled snapshot alone.
  public func firstRun(
    bundle: BundledDataset?, paths: NetworkPaths = .every,
    progress: @escaping @Sendable (SyncProgress) async -> Void
  ) async throws -> FirstRunResult {
    guard !updating else { throw ImportError.alreadyUpdating }
    updating = true
    defer { updating = false }
    return try await TraceContext.$operation.withValue(UUID()) {
      guard let bundle else {
        return FirstRunResult(
          manifest: try await perform(paths: paths, progress: progress), outcome: .listed)
      }
      return try await perform(bundle: bundle, paths: paths, progress: progress)
    }
  }

  private func perform(
    bundle: BundledDataset, paths: NetworkPaths,
    progress: @escaping @Sendable (SyncProgress) async -> Void
  ) async throws -> FirstRunResult {
    trace.record(TraceEvent(phase: .discovery, outcome: .started))
    let listing = try await discover(bundle: bundle, paths: paths)
    guard let archive = listing.archive, listing.plan.transfer != .none else {
      trace.record(
        TraceEvent(
          phase: .discovery, outcome: listing.archive == nil ? .deferred : .completed,
          snapshot: bundle.entry.snapshot))
      return FirstRunResult(
        manifest: try await stage(bundle: bundle, progress: progress),
        outcome: listing.archive == nil ? .bundled : .listed)
    }
    trace.record(TraceEvent(phase: .discovery, outcome: .completed, snapshot: archive.snapshot))
    await progress(
      SyncProgress(
        stage: SyncProgress.transfer, done: 0, total: 0, rows: archive.contacts, fraction: 0))
    do {
      if let delta = listing.delta {
        try await stage(
          delta: delta, from: bundle, archive: archive, paths: paths, progress: progress)
      } else {
        try await stage(archive: archive, paths: paths, progress: progress)
      }
      return FirstRunResult(
        manifest: try await activate(
          snapshot: archive.snapshot, rows: archive.contacts, progress: progress),
        outcome: .listed)
    } catch ImportError.activationUncertain {
      // The new generation may already be active, so the bundle must not replace it.
      throw ImportError.activationUncertain
    } catch let failure as SyncFailure {
      // The store couldn't remove the unfinished generation, so it can't stage another one.
      throw failure
    } catch {
      if Task.isCancelled || error is CancellationError { throw CancellationError() }
      return FirstRunResult(
        manifest: try await stage(bundle: bundle, progress: progress), outcome: .bundled)
    }
  }

  /// Reads the listing and, when it names another snapshot, the delta listing, and plans the run from them.
  private func discover(bundle: BundledDataset, paths: NetworkPaths) async throws
    -> FirstRunListing
  {
    let bundled = bundle.entry.snapshot
    do {
      let listing = try await api.datasets(paths: paths)
      let archive = listing.archive
      guard archive.snapshot != bundled else {
        return FirstRunListing(
          plan: .decide(bundle: .readable, listing: .namesBundled(archiveBytes: archive.bytes)),
          archive: archive, delta: nil)
      }
      let extra =
        try await searchArtifacts?.transferBytes(
          snapshot: archive.snapshot, contacts: archive.contacts, paths: paths) ?? 0
      if let link = listing.deltas,
        let delta = try await api.directoryDeltas(link: link, paths: paths).first(where: {
          $0.base == bundled && $0.snapshot == archive.snapshot
            && $0.archiveSha256 == archive.sha256
        })
      {
        return FirstRunListing(
          plan: .decide(
            bundle: .readable,
            listing: .deltaFromBundled(
              deltaBytes: delta.bytes + extra, archiveBytes: archive.bytes + extra)),
          archive: archive, delta: delta)
      }
      return FirstRunListing(
        plan: .decide(
          bundle: .readable, listing: .noDeltaFromBundled(archiveBytes: archive.bytes + extra)),
        archive: archive, delta: nil)
    } catch {
      if Task.isCancelled || error is CancellationError { throw CancellationError() }
      return FirstRunListing(
        plan: .decide(bundle: .readable, listing: .unreachable), archive: nil, delta: nil)
    }
  }

  /// Rebuilds the listed archive from the decoded bundle through `delta`, and stages it.
  private func stage(
    delta: DatasetDelta, from bundle: BundledDataset, archive: DatasetArchive, paths: NetworkPaths,
    progress: @escaping @Sendable (SyncProgress) async -> Void
  ) async throws {
    trace.record(TraceEvent(phase: .delta, outcome: .started, snapshot: archive.snapshot))
    let directory = temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    do {
      let transfer = Self.downloadShare * Self.deltaTransferShare
      let rows = archive.contacts
      let file = try await api.download(delta, paths: paths, partials: store.transfers) { part in
        Task {
          await progress(
            SyncProgress(
              stage: SyncProgress.transfer, done: part.received, total: part.total - part.resumed,
              rows: rows,
              fraction: Double(part.resumed + part.received) / Double(max(part.total, 1))
                * transfer, waiting: part.waiting))
        }
      }
      defer { try? FileManager.default.removeItem(at: file) }
      let base = try await DecodedArchive.decode(
        bundle.archive, into: directory.appendingPathComponent("base"))
      let rebuilt = directory.appendingPathComponent("rebuilt")
      let admission = try await DirectoryDeltaApplier(url: file, delta: delta).rebuild(
        from: base.base, into: rebuilt
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
        paths: paths, progress: progress)
      trace.record(TraceEvent(phase: .delta, outcome: .completed, snapshot: archive.snapshot))
    } catch {
      trace.record(
        TraceEvent(
          phase: .delta, outcome: Task.isCancelled ? .cancelled : .rejected,
          snapshot: archive.snapshot))
      throw error
    }
  }

  /// Downloads the complete archive and stages it.
  private func stage(
    archive: DatasetArchive, paths: NetworkPaths,
    progress: @escaping @Sendable (SyncProgress) async -> Void
  ) async throws {
    let rows = archive.contacts
    let file = try await api.download(archive, paths: paths, partials: store.transfers) { part in
      Task {
        await progress(
          SyncProgress(
            stage: SyncProgress.transfer, done: part.received, total: part.total - part.resumed,
            rows: rows,
            fraction: Double(part.resumed + part.received) / Double(max(part.total, 1))
              * Self.downloadShare, waiting: part.waiting))
      }
    }
    defer { try? FileManager.default.removeItem(at: file) }
    try await stage(
      DirectoryArchiveReader(url: file, trace: trace), archive: archive, paths: paths,
      progress: progress)
  }

  /// Stages and activates the bundled archive, and reports rows that fail their checks as an unreadable bundle.
  private func stage(
    bundle: BundledDataset, progress: @escaping @Sendable (SyncProgress) async -> Void
  ) async throws -> SnapshotManifest {
    let archive = bundle.entry.archive
    do {
      try await stage(
        DirectoryArchiveReader(url: bundle.archive, trace: trace), archive: archive,
        progress: progress)
    } catch ImportError.invalidRecord, ImportError.invalidSnapshot, ImportError.unexpectedCount {
      throw BundleMismatch(field: .rows)
    } catch is BrotliError {
      throw BundleMismatch(field: .rows)
    }
    return try await activate(
      snapshot: archive.snapshot, rows: archive.contacts, progress: progress)
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

  /// Synchronizes from a listing that an answered check already read, so the transfer reads the listing no second time.
  public func synchronize(
    listing: DatasetListing, paths: NetworkPaths,
    progress: @escaping @Sendable (SyncProgress) async -> Void
  ) async throws -> SnapshotManifest {
    guard !updating else { throw ImportError.alreadyUpdating }
    updating = true
    defer { updating = false }
    return try await TraceContext.$operation.withValue(UUID()) {
      try await perform(listing: listing, paths: paths, progress: progress)
    }
  }

  private func perform(
    paths: NetworkPaths, progress: @escaping @Sendable (SyncProgress) async -> Void
  ) async throws -> SnapshotManifest {
    trace.record(TraceEvent(phase: .discovery, outcome: .started))
    return try await perform(
      listing: api.datasets(paths: paths), paths: paths, progress: progress)
  }

  private func perform(
    listing: DatasetListing, paths: NetworkPaths,
    progress: @escaping @Sendable (SyncProgress) async -> Void
  ) async throws -> SnapshotManifest {
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
              * Self.downloadShare, waiting: part.waiting))
      }
    }
    try await stage(
      DirectoryArchiveReader(url: file, trace: trace), archive: archive, paths: paths,
      progress: progress)
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
                * transfer, waiting: part.waiting))
        }
      }
      defer { try? FileManager.default.removeItem(at: file) }
      let rebuilt = temporaryDirectory.appendingPathComponent(UUID().uuidString)
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
        paths: paths, progress: progress)
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
    paths: NetworkPaths = .every,
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
      let artifacts = try await searchArtifacts?.files(
        snapshot: archive.snapshot, contacts: archive.contacts, paths: paths,
        partials: store.searchTransfers)
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
            try await store.begin(
              header: header, origin: api.origin, requiresRankedSearch: artifacts != nil)
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
      if let artifacts { try await store.installSearch(artifacts) }
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
      await releaseSearch(snapshot: snapshot)
      await progress(
        SyncProgress(stage: SyncProgress.identify, done: 1, total: 1, rows: rows, fraction: 1))
      return manifest
    } catch {
      try await discard(after: error, snapshot: snapshot)
    }
  }

  private func releaseSearch(snapshot: SnapshotID) async {
    do {
      try await searchArtifacts?.release(snapshot: snapshot, partials: store.searchTransfers)
    } catch {
      trace.record(TraceEvent(phase: .cleanup, outcome: .deferred, snapshot: snapshot))
    }
  }

  public func upgradeSearch(paths: NetworkPaths = .inexpensive) async throws -> SnapshotManifest {
    guard !updating else { throw ImportError.alreadyUpdating }
    updating = true
    defer { updating = false }
    guard let saved = try await store.manifest() else { throw ImportError.unavailableStorage }
    if saved.rankedSearch == true, await store.searchUsesMappedFiles(generation: saved.generation) {
      return saved
    }
    guard let searchArtifacts else { throw ImportError.invalidSnapshot }
    let header = try await store.header(generation: saved.generation)
    let artifacts = try await searchArtifacts.files(
      snapshot: saved.snapshot, contacts: saved.records, paths: paths,
      partials: store.searchTransfers)
    do {
      try await store.begin(
        header: header, origin: saved.origin.flatMap(URL.init(string:)), requiresRankedSearch: true)
      for start in stride(from: 0, to: saved.records, by: SnapshotStore.archiveRowBatch) {
        try Task.checkCancellation()
        let lines = try await store.archiveRows(
          generation: saved.generation, from: start,
          count: min(SnapshotStore.archiveRowBatch, saved.records - start))
        try await store.append(lines.map { try ArchiveRecord(line: $0, header: header) })
      }
      try await store.installSearch(artifacts)
      let manifest = try await store.publish(at: now())
      await releaseSearch(snapshot: saved.snapshot)
      return manifest
    } catch {
      try await discard(after: error, snapshot: saved.snapshot)
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

/// The listing's answer for a first run from a readable bundle, with the files that the plan transfers.
struct FirstRunListing: Sendable {
  let plan: FirstRunPlan
  /// The listed archive, or nil when the listing failed.
  let archive: DatasetArchive?
  /// The listed delta from the bundled snapshot to `archive`.
  let delta: DatasetDelta?
}

/// The snapshot that a first run saved.
public enum FirstRunOutcome: Sendable, Equatable {
  /// The listed snapshot, received through the planned transfer or already in the bundle.
  case listed
  /// The bundled snapshot alone, because the listing, the transfer, the rebuild, or a check failed.
  case bundled
}

public struct FirstRunResult: Sendable {
  public let manifest: SnapshotManifest
  public let outcome: FirstRunOutcome
}

public struct SyncFailure: Error, Sendable {
  public let primary: any Error
  public let cleanup: any Error
}
