import Foundation
import Observation
import PhonebookCore

@Observable @MainActor
public final class DirectoryModel {
  private final class Run: Sendable {}
  private nonisolated static let contactBatchSize = 500
  public static let pageSize = ResultPage.size

  public var query = ""
  public private(set) var results: SearchResults?
  public private(set) var loading = false
  public private(set) var searching = false
  public private(set) var loadingMore = false
  public private(set) var failed = false
  public private(set) var categories: [CategoryInfo] = []
  public private(set) var generation: UUID?
  public private(set) var shown = 0
  private var contacts: [Int64: Contact] = [:]
  @ObservationIgnored private let store: any DirectorySearchSource
  @ObservationIgnored private var index: LocalSearch?
  @ObservationIgnored private var scorer: SavedRankedSearch?
  @ObservationIgnored private var manifest: SnapshotManifest?
  @ObservationIgnored private var operation: Task<Void, Never>?
  @ObservationIgnored private var paging: Task<Void, Never>?
  @ObservationIgnored private var loadRun: Run?
  @ObservationIgnored private var searchRun: Run?
  @ObservationIgnored private var pageRun: Run?
  @ObservationIgnored private var searched: String?

  public init(store: any DirectorySearchSource) { self.store = store }

  public var ready: Bool { scorer != nil || index != nil }
  public var visible: [Contact] {
    results?.ids.prefix(shown).compactMap { contacts[$0] } ?? []
  }
  public var expandable: Bool { shown < (results?.total ?? 0) }

  public func activate(_ manifest: SnapshotManifest?) async {
    guard manifest?.generation != generation || !ready else { return }
    let run = Run()
    loadRun = run
    operation?.cancel()
    paging?.cancel()
    paging = nil
    loadingMore = false
    pageRun = nil
    searchRun = nil
    self.manifest = manifest
    generation = manifest?.generation
    index = nil
    scorer = nil
    contacts = [:]
    categories = []
    results = nil
    searched = nil
    shown = 0
    searching = false
    failed = false
    loading = generation != nil
    guard let generation else { return }
    do {
      let header = try await store.header(generation: generation)
      let scorer = try await store.rankedSearch(generation: generation)
      let index = scorer == nil ? try await store.searchIndex(generation: generation) : nil
      try Task.checkCancellation()
      guard loadRun === run else { return }
      categories = header.categories.map {
        CategoryInfo(
          id: $0.id, label: $0.label, publisher: $0.publisher, license: $0.license,
          licenseURL: $0.licenseUrl)
      }
      self.index = index
      self.scorer = scorer
      loading = false
      searched = nil
      search()
    } catch {
      guard loadRun === run else { return }
      loading = false
      failed = !(error is CancellationError)
    }
  }

  @discardableResult
  public func search() -> Task<Void, Never>? {
    guard searched?.utf8.elementsEqual(query.utf8) != true else { return operation }
    searched = query
    operation?.cancel()
    paging?.cancel()
    paging = nil
    loadingMore = false
    pageRun = nil
    shown = 0
    results = nil
    let run = Run()
    searchRun = run
    failed = false
    guard !RankingText.compact(query).isEmpty, ready, let generation else {
      operation = nil
      searching = false
      return nil
    }
    searching = true
    failed = false
    let store = store
    let scorer = scorer
    let index = index
    let typed = query
    let phone = SearchInput.normalizedPhone(typed).flatMap { try? CanonicalPhone($0) }
    let task = Task {
      do {
        let ids: [Int64]
        if let phone {
          let matches = try await store.contactIDs(generation: generation, number: phone.number)
          let names = try await store.searchIndex(generation: generation)
          ids = try names.orderedIDs(names.exact(matches))
        } else {
          let work = Task.detached(priority: .userInitiated) {
            try Task.checkCancellation()
            let ids: [Int64]
            if let scorer {
              ids = try scorer.search(typed).map(\.id)
            } else if let index {
              ids = try index.orderedIDs(index.search(SearchInput.words(typed)))
            } else {
              throw ImportError.unavailableStorage
            }
            try Task.checkCancellation()
            return ids
          }
          ids = try await withTaskCancellationHandler {
            try await work.value
          } onCancel: {
            work.cancel()
          }
        }
        let target = ResultPage.end(shown: 0, total: ids.count)
        let loaded = try await Self.fetch(
          Array(ids.prefix(target)), generation: generation, store: store, cached: [:])
        try Task.checkCancellation()
        guard searchRun === run else { return }
        contacts = loaded
        shown = target
        results = SearchResults(
          input: typed, ids: ids,
          limited: scorer != nil && phone == nil && ids.count == RankingPolicy.results)
        failed = false
        searching = false
      } catch {
        guard searchRun === run, !(error is CancellationError) else { return }
        results = nil
        failed = true
        searching = false
      }
    }
    operation = task
    return task
  }

  public func retry() {
    if ready {
      searched = nil
      search()
    } else {
      Task { await activate(manifest) }
    }
  }

  @discardableResult
  public func more() -> Task<Void, Never>? {
    guard let results, let generation, expandable, !searching else { return nil }
    if let paging { return paging }
    let run = Run()
    pageRun = run
    loadingMore = true
    let target = ResultPage.end(shown: shown, total: results.total)
    let cached = contacts
    let store = store
    let task = Task {
      defer {
        if pageRun === run {
          pageRun = nil
          paging = nil
          loadingMore = false
        }
      }
      do {
        let loaded = try await Self.fetch(
          Array(results.ids.prefix(target)), generation: generation, store: store, cached: cached)
        try Task.checkCancellation()
        guard pageRun === run else { return }
        contacts = loaded
        shown = target
      } catch {
        guard pageRun === run, !(error is CancellationError) else { return }
        failed = true
      }
    }
    paging = task
    return task
  }

  private nonisolated static func fetch(
    _ ids: [Int64], generation: UUID, store: any DirectorySearchSource,
    cached: [Int64: Contact]
  ) async throws -> [Int64: Contact] {
    var result = cached
    let missing = ids.filter { result[$0] == nil }
    for start in stride(from: 0, to: missing.count, by: contactBatchSize) {
      try Task.checkCancellation()
      let chunk = Array(missing[start..<min(start + contactBatchSize, missing.count)])
      for contact in try await store.contacts(generation: generation, ids: chunk) {
        result[contact.id] = contact
      }
    }
    guard ids.allSatisfy({ result[$0] != nil }) else { throw ImportError.invalidRecord }
    return result
  }
}
