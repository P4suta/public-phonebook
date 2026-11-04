import Foundation
import Observation
import PhonebookCore

/// Searches the saved national directory on the device as the reader types.
@Observable @MainActor
public final class DirectoryModel {
  public static let previewSize = 3
  public static let pageSize = 50

  public var query = ""
  public private(set) var results: SearchResults?
  public private(set) var searching = false
  public private(set) var failed = false
  public private(set) var categories: [CategoryInfo] = []
  public private(set) var generation: UUID?
  public private(set) var shown: [Int: Int] = [:]
  private var contacts: [Int64: Contact] = [:]
  @ObservationIgnored private let store: SnapshotStore
  @ObservationIgnored private var index: LocalSearch?
  @ObservationIgnored private var operation: Task<Void, Never>?
  @ObservationIgnored private var paging: Task<Void, Never>?
  @ObservationIgnored private var searched: String?

  public init(store: SnapshotStore) { self.store = store }

  public var ready: Bool { index != nil }

  public func activate(_ manifest: SnapshotManifest?) async {
    guard manifest?.generation != generation || index == nil else { return }
    operation?.cancel()
    generation = manifest?.generation
    index = nil
    contacts = [:]
    results = nil
    searched = nil
    guard let generation else { return }
    do {
      let index = try await store.searchIndex(generation: generation)
      let header = try await store.header(generation: generation)
      guard generation == self.generation else { return }
      categories = header.categories.map {
        CategoryInfo(
          id: $0.id, label: $0.label, publisher: $0.publisher, license: $0.license,
          licenseURL: $0.licenseUrl)
      }
      self.index = index
      failed = false
      search()
    } catch { failed = true }
  }

  /// Searches for the current query and returns the task that answers it, or nil when the query needs no search.
  /// The task ends once `results`, `failed`, and `searching` describe the query, or once a newer search cancels it.
  @discardableResult
  public func search() -> Task<Void, Never>? {
    let normalized = SearchInput.normalizedName(query)
    guard normalized != searched else { return operation }
    searched = normalized
    operation?.cancel()
    paging?.cancel()
    shown = [:]
    guard !normalized.isEmpty, let index, let generation else {
      operation = nil
      results = nil
      searching = false
      return nil
    }
    searching = true
    let store = store
    let categories = categories
    let phone = SearchInput.normalizedPhone(query).flatMap { try? CanonicalPhone($0) }
    let task = Task {
      do {
        let groups: [[LocalSearch.Match]]
        if let phone {
          let ids = try await store.contactIDs(generation: generation, number: phone.number)
          groups = try index.exact(ids)
        } else {
          let work = Task.detached(priority: .userInitiated) { try index.search(normalized) }
          groups = try await withTaskCancellationHandler {
            try await work.value
          } onCancel: {
            work.cancel()
          }
        }
        try Task.checkCancellation()
        let result = SearchResults(
          query: normalized,
          groups: groups.compactMap { matches in
            guard let first = matches.first else { return nil }
            let category = index.category(row: first.row)
            guard categories.indices.contains(category) else { return nil }
            return ResultGroup(
              category: category, key: categories[category].id,
              label: categories[category].label, ids: matches.map(\.id))
          })
        let previews = try await fetch(
          result.groups.flatMap { $0.ids.prefix(Self.previewSize) }, cached: [:])
        try Task.checkCancellation()
        contacts = previews
        results = result
        failed = false
        searching = false
      } catch is CancellationError {
      } catch {
        results = nil
        failed = true
        searching = false
      }
    }
    operation = task
    return task
  }

  public func retry() {
    searched = nil
    search()
  }

  public func visible(_ group: ResultGroup) -> [Contact] {
    group.ids.prefix(shown[group.category] ?? Self.previewSize).compactMap { contacts[$0] }
  }

  public func expandable(_ group: ResultGroup) -> Bool {
    (shown[group.category] ?? Self.previewSize) < group.total
  }

  public func expanded(_ group: ResultGroup) -> Bool { shown[group.category] != nil }

  /// Shows the next page of the group and returns the task that loads it, or the page task already running.
  /// It returns nil when the group already shows every match.
  @discardableResult
  public func more(_ group: ResultGroup) -> Task<Void, Never>? {
    guard expandable(group) else { return nil }
    if let paging { return paging }
    let target = min(group.total, (shown[group.category] ?? Self.previewSize) + Self.pageSize)
    let ids = Array(group.ids.prefix(target))
    let task = Task {
      defer { paging = nil }
      do {
        let loaded = try await fetch(ids, cached: contacts)
        try Task.checkCancellation()
        contacts = loaded
        shown[group.category] = target
      } catch is CancellationError {
      } catch { failed = true }
    }
    paging = task
    return task
  }

  private func fetch(_ ids: [Int64], cached: [Int64: Contact]) async throws -> [Int64: Contact] {
    guard let generation else { return cached }
    var result = cached
    let missing = ids.filter { result[$0] == nil }
    for start in stride(from: 0, to: missing.count, by: 500) {
      let chunk = Array(missing[start..<min(start + 500, missing.count)])
      for contact in try await store.contacts(generation: generation, ids: chunk) {
        result[contact.id] = contact
      }
    }
    return result
  }
}
