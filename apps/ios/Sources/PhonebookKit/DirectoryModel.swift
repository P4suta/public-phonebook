import Foundation
import Observation
import PhonebookCore

@Observable @MainActor
public final class DirectoryModel {
  private final class Run: Sendable {}
  private nonisolated static let contactBatchSize = 500
  public static let previewSize = 3
  public static let pageSize = ResultPage.size

  public var query = ""
  public private(set) var results: SearchResults?
  public private(set) var loading = false
  public private(set) var searching = false
  public private(set) var loadingMore = false
  public private(set) var failed = false
  public private(set) var categories: [CategoryInfo] = []
  public private(set) var generation: UUID?
  /// How many matches each expanded category shows, keyed by category index.
  public private(set) var shown: [Int: Int] = [:]
  private var contacts: [Int64: Contact] = [:]
  @ObservationIgnored private let store: any DirectorySearchSource
  @ObservationIgnored private var index: LocalSearch?
  @ObservationIgnored private var manifest: SnapshotManifest?
  @ObservationIgnored private var operation: Task<Void, Never>?
  @ObservationIgnored private var paging: Task<Void, Never>?
  @ObservationIgnored private var loadRun: Run?
  @ObservationIgnored private var searchRun: Run?
  @ObservationIgnored private var pageRun: Run?
  @ObservationIgnored private var searched: String?

  public init(store: any DirectorySearchSource) {
    self.store = store
  }

  public var ready: Bool { index != nil }

  public func visible(_ group: ResultGroup) -> [Contact] {
    group.ids.prefix(shown[group.category] ?? Self.previewSize).compactMap { contacts[$0] }
  }

  public func expandable(_ group: ResultGroup) -> Bool {
    (shown[group.category] ?? Self.previewSize) < group.total
  }

  public func expanded(_ group: ResultGroup) -> Bool { shown[group.category] != nil }

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
    contacts = [:]
    categories = []
    results = nil
    searched = nil
    shown = [:]
    searching = false
    failed = false
    loading = generation != nil
    guard let generation else { return }
    do {
      let header = try await store.header(generation: generation)
      let index = try await store.searchIndex(generation: generation)
      try Task.checkCancellation()
      guard loadRun === run else { return }
      categories = header.categories.map {
        CategoryInfo(
          id: $0.id, label: $0.label, publisher: $0.publisher, license: $0.license,
          licenseURL: $0.licenseUrl)
      }
      self.index = index
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
    shown = [:]
    results = nil
    contacts = [:]
    let run = Run()
    searchRun = run
    failed = false
    guard
      SearchInput.foldedCharacters(query).unicodeScalars.contains(where: {
        !$0.properties.isWhitespace
      }), ready, let generation
    else {
      operation = nil
      searching = false
      return nil
    }
    searching = true
    failed = false
    let store = store
    let index = index
    let categories = categories
    let typed = query
    let phone = SearchInput.normalizedPhone(typed).flatMap { try? CanonicalPhone($0) }
    let task = Task {
      defer {
        if searchRun === run { searching = false }
      }
      do {
        let groups: [ResultGroup]
        var loaded: [Int64: Contact] = [:]
        if let phone {
          let matches = try await store.contactIDs(generation: generation, number: phone.number)
          let names = try await store.searchIndex(generation: generation)
          groups = Self.groups(try names.exact(matches), index: names, categories: categories)
        } else if let index {
          let words = SearchInput.words(typed)
          let matches = try await Self.detached { try index.search(words) }
          groups = Self.groups(matches, index: index, categories: categories)
        } else {
          throw ImportError.unavailableStorage
        }
        loaded = try await Self.fetch(
          groups.flatMap { $0.ids.prefix(Self.previewSize) }, generation: generation,
          store: store, cached: loaded)
        try Task.checkCancellation()
        guard searchRun === run else { return }
        contacts = loaded
        results = SearchResults(
          input: typed, groups: groups,
          limited: false)
        failed = false
      } catch {
        guard searchRun === run else { return }
        results = nil
        failed = !(error is CancellationError)
      }
    }
    operation = task
    return task
  }

  @discardableResult
  public func retry() -> Task<Void, Never>? {
    if ready {
      searched = nil
      return search()
    } else {
      return Task { await activate(manifest) }
    }
  }

  /// Shows the next page of the category and returns the task that loads it, or the page task already running.
  /// It returns nil when the category already shows every match.
  @discardableResult
  public func more(_ group: ResultGroup) -> Task<Void, Never>? {
    guard let generation, expandable(group), !searching else { return nil }
    if let paging { return paging }
    let run = Run()
    pageRun = run
    loadingMore = true
    let target = ResultPage.end(
      shown: shown[group.category] ?? Self.previewSize, total: group.total)
    let ids = Array(group.ids.prefix(target))
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
        let loaded = try await Self.fetch(ids, generation: generation, store: store, cached: cached)
        try Task.checkCancellation()
        guard pageRun === run else { return }
        contacts = loaded
        shown[group.category] = target
      } catch {
        guard pageRun === run, !(error is CancellationError) else { return }
        failed = true
      }
    }
    paging = task
    return task
  }

  private nonisolated static func detached<Value: Sendable>(
    _ work: @escaping @Sendable () throws -> Value
  ) async throws -> Value {
    let task = Task.detached(priority: .userInitiated) {
      try Task.checkCancellation()
      let value = try work()
      try Task.checkCancellation()
      return value
    }
    return try await withTaskCancellationHandler {
      try await task.value
    } onCancel: {
      task.cancel()
    }
  }

  /// Names the groups that the literal index returns, in its order.
  private nonisolated static func groups(
    _ matches: [[LocalSearch.Match]], index: LocalSearch, categories: [CategoryInfo]
  ) -> [ResultGroup] {
    matches.compactMap { group in
      guard let first = group.first else { return nil }
      let category = index.category(row: first.row)
      guard categories.indices.contains(category) else { return nil }
      return ResultGroup(
        category: category, key: categories[category].id, label: categories[category].label,
        ids: group.map(\.id))
    }
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
