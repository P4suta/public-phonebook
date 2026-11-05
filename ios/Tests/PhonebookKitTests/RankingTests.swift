import Foundation
import PhonebookCore
import Testing

@testable import PhonebookKit

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
