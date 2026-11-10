import Foundation
import PhonebookCore

public actor WatchDirectorySearch {
  private let store: SnapshotStore

  public init(store: SnapshotStore) {
    self.store = store
  }

  public func search(_ request: WatchSearchRequest) async throws -> WatchSearchReply {
    try Task.checkCancellation()
    guard let manifest = try await store.manifest() else {
      return try WatchSearchReply(
        requestID: request.id, state: .needsPreparation, results: [], total: 0)
    }
    let index = try await store.searchIndex(generation: manifest.generation)
    let matches: [[LocalSearch.Match]]
    if let normalized = SearchInput.normalizedPhone(request.query),
      let phone = try? CanonicalPhone(normalized)
    {
      let ids = try await store.contactIDs(generation: manifest.generation, number: phone.number)
      matches = try index.exact(ids)
    } else {
      matches = try index.search(SearchInput.words(request.query))
    }
    let ids = try index.orderedIDs(matches)
    let contacts = try await store.contacts(
      generation: manifest.generation, ids: Array(ids.prefix(WatchSearchReply.maximumResults)))
    guard contacts.count == min(ids.count, WatchSearchReply.maximumResults) else {
      throw ImportError.invalidSnapshot
    }
    var results = try contacts.map { contact in
      try WatchFacility(
        id: contact.id, name: contact.name, region: contact.region,
        numbers: contact.phones.map(\.e164.rawValue), publisher: contact.provenance.publisher,
        sourceURL: contact.provenance.sourceURL, license: contact.provenance.license,
        licenseURL: contact.provenance.licenseURL)
    }
    try Task.checkCancellation()
    while true {
      do {
        return try WatchSearchReply(
          requestID: request.id, state: .ready, results: results, total: ids.count)
      } catch WatchSearchError.invalidReply {
        guard results.count > 1 else { throw WatchSearchError.invalidReply }
        results.removeLast()
      }
    }
  }
}
