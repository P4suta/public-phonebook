import Foundation
import PhonebookCore

public struct Phone: Codable, Hashable, Sendable {
  public let display: String
  public let e164: CanonicalPhone

  public init(display: String, e164: CanonicalPhone) {
    self.display = display
    self.e164 = e164
  }
}

public struct Provenance: Hashable, Sendable {
  public let publisher: String
  public let sourceURL: String?
  public let publications: [String]
  public let license: String
  public let licenseURL: String
  public let dataAsOf: String
  public let retrievedAt: String
  public let confirmed: Bool
  public let confirmationURL: String?
}

public struct Contact: Identifiable, Hashable, Sendable {
  public let id: Int64
  public let name: String
  public let categoryKey: String
  public let category: String
  public let prefecture: String
  public let municipality: String?
  public let address: String
  public let phones: [Phone]
  public let website: String?
  public let provenance: Provenance

  public var region: String { prefecture + (municipality ?? "") }
}

public struct CategoryInfo: Identifiable, Sendable {
  public let id: String
  public let label: String
  public let publisher: String
  public let license: String
  public let licenseURL: String
}

public struct ResultGroup: Identifiable, Sendable {
  public let category: Int
  public let key: String
  public let label: String
  public let ids: [Int64]
  public var id: Int { category }
  public var total: Int { ids.count }
}

public struct SearchResults: Sendable {
  public let query: String
  /// The query text as typed, whose normalized form is `query`.
  public let input: String
  public let groups: [ResultGroup]
  public var total: Int { groups.reduce(0) { $0 + $1.total } }
}

public enum ImportError: Error, Equatable, Sendable {
  case oversizedRecord, invalidRecord, invalidSnapshot, unexpectedCount, alreadyUpdating
  case unavailableStorage, activationUncertain, projectionTooLarge
}
