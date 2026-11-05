import CryptoKit
import Foundation
import PhonebookCore
import Testing

@testable import PhonebookKit

private struct RankingFixture: Decodable {
  struct Query: Decodable {
    let query: String
    let hits: [[Int64]]
  }
  let format: String
  let snapshot: String
  let contacts: Int
  let indexSha256: String
  let rankingSha256: String
  let queries: [Query]
}

private var rankingRoot: URL {
  URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()
}

private func rankingDigest(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

@Test func nationalRankingsMatchEveryCommittedRowAndScore() throws {
  let fixture = try JSONDecoder().decode(
    RankingFixture.self,
    from: Data(contentsOf: rankingRoot.appending(path: "tests/fixtures/search-ranking.json")))
  #expect(fixture.format == "public-phonebook-name-ranking/1")
  #expect(fixture.queries.count == 2200)
  let compressedIndex = try Data(
    contentsOf: rankingRoot.appending(path: "ios/SearchData/search-index.br"))
  let indexBytes = try #require(
    try? SearchArtifacts.decompress(compressedIndex), "Name index decompression failed")
  let compressedRanking = try Data(
    contentsOf: rankingRoot.appending(path: "ios/SearchData/search-ranking.br"))
  let rankingBytes = try #require(
    try? SearchArtifacts.decompress(compressedRanking), "Ranking decompression failed")
  #expect(rankingDigest(indexBytes) == fixture.indexSha256)
  #expect(rankingDigest(rankingBytes) == fixture.rankingSha256)
  let index = try SearchArtifacts.index(indexBytes)
  #expect(index.snapshot == fixture.snapshot)
  #expect(index.rows.count == fixture.contacts)
  let artifact = try #require(
    try? SearchArtifacts.ranking(
      rankingBytes, snapshot: fixture.snapshot, contacts: fixture.contacts),
    "Ranking admission failed")
  let scorer = try #require(try? index.scorer(artifact), "Scorer construction failed")
  for query in fixture.queries {
    let actual = try scorer.search(query.query).map { [Int64($0.row), $0.score] }
    let expectedScores = Dictionary(uniqueKeysWithValues: query.hits.map { ($0[0], $0[1]) })
    let changed = actual.filter { expectedScores[$0[0]] != $0[1] }.prefix(5).map {
      "\(index.rows[Int($0[0])].name): \($0[1]), expected \(expectedScores[$0[0]] ?? -1)"
    }
    #expect(actual == query.hits, "Full ranking differs for \(query.query): \(changed)")
    if actual != query.hits { return }
  }
  #expect(try scorer.search("").isEmpty)
  #expect(try scorer.search(String(repeating: "a", count: 257)).isEmpty)
}

private func smallRanking(_ suffix: [UInt8] = [1], count: Int = 1, rowCount: Int = 1) -> Data {
  let snapshot = String(repeating: "a", count: 64)
  let metadata = """
    {"snapshot":"\(snapshot)","contacts":\(count),"analyzer":{"engine":"fixture","dictionary":"\(snapshot)"},"readings":["library"],"lexicon":[],"aliases":[],"variants":[],"unknownWeight":1,"lexical":[["li",1,\(rowCount)]],"phonetic":[]}
    """
  return Data("public-phonebook-search-ranking\t1\n\(metadata)\n".utf8) + Data(suffix)
}

@Test func rankingAdmissionRejectsCorruptionAndMismatchedIdentities() throws {
  let snapshot = String(repeating: "a", count: 64)
  #expect(
    try SearchArtifacts.ranking(smallRanking(), snapshot: snapshot, contacts: 1).lexical[0].rows
      == [0])
  for bytes in [[UInt8](), [0], [2], [0x81, 0], [0x80, 0x80, 0x80, 0x80, 1], [1, 1]] {
    #expect(throws: (any Error).self) {
      try SearchArtifacts.ranking(smallRanking(bytes), snapshot: snapshot, contacts: 1)
    }
  }
  #expect(throws: (any Error).self) {
    try SearchArtifacts.ranking(
      smallRanking(), snapshot: String(repeating: "b", count: 64), contacts: 1)
  }
  #expect(throws: (any Error).self) {
    try SearchArtifacts.ranking(smallRanking(count: 2), snapshot: snapshot, contacts: 2)
  }
  #expect(throws: (any Error).self) {
    try SearchArtifacts.ranking(smallRanking(rowCount: -1), snapshot: snapshot, contacts: 1)
  }
  #expect(throws: (any Error).self) { try SearchArtifacts.decompress(Data([1, 2, 3])) }
}
