import Foundation
import PhonebookCore

public actor SyncEngine {
  /// Shares of the overall progress for downloading, saving records, and preparing numbers.
  static let downloadShare = 0.4
  static let saveShare = 0.55

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
    let discovery = try await api.discovery()
    let snapshot = discovery.meta.snapshot
    trace.record(TraceEvent(phase: .discovery, outcome: .completed, snapshot: snapshot))
    let archive = try await api.directoryArchive(link: discovery.data.datasets)
    guard archive.snapshot == snapshot else { throw ImportError.invalidSnapshot }
    await progress(0)
    let file = try await api.download(archive) { fraction in
      Task { await progress(min(max(fraction, 0), 1) * Self.downloadShare) }
    }
    defer { try? FileManager.default.removeItem(at: file) }
    do {
      _ = try await DirectoryArchiveReader(url: file).read(
        header: { header in
          guard header.snapshot == snapshot, header.contacts == archive.contacts else {
            throw ImportError.invalidSnapshot
          }
          try await store.begin(header: header, origin: api.origin)
        },
        records: { records, consumed in
          try Task.checkCancellation()
          try await store.append(records)
          let read = Double(min(consumed, archive.bytes)) / Double(max(archive.bytes, 1))
          await progress(Self.downloadShare + read * Self.saveShare)
        })
      trace.record(TraceEvent(phase: .decode, outcome: .completed, snapshot: snapshot))
      await progress(Self.downloadShare + Self.saveShare)
      try Task.checkCancellation()
      let manifest = try await store.publish(at: now())
      await progress(1)
      return manifest
    } catch {
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
}

public struct SyncFailure: Error, Sendable {
  public let primary: any Error
  public let cleanup: any Error
}
