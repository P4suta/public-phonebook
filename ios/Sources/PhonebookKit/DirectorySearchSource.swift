import Foundation
import PhonebookCore
import PhonebookRanking

public protocol DirectorySearchSource: Sendable {
  func header(generation: UUID) async throws -> ArchiveHeader
  func searchIndex(generation: UUID) async throws -> LocalSearch
  func rankedSearch(generation: UUID) async throws -> SavedRankedSearch?
  func contactIDs(generation: UUID, number: Int64) async throws -> [Int64]
  func contacts(generation: UUID, ids: [Int64]) async throws -> [Contact]
}

extension SnapshotStore: DirectorySearchSource {}
