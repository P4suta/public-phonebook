import Compression
import CryptoKit
import Foundation
import PhonebookCore
import Synchronization
import Testing

@testable import PhonebookKit

/// The largest file a kit test process may write, the same cap that the core tests carry.
/// A runaway writer then fails with File too large instead of filling the disk, and the mutation gate counts that as a resource stop.
let testFileLimit: UInt64 = 256 * 1024 * 1024

/// Caps this test process once and turns a write past the cap into an error instead of a signal.
private let capped: Bool = {
  var limit = rlimit()
  guard getrlimit(RLIMIT_FSIZE, &limit) == 0 else { return false }
  limit.rlim_cur = min(limit.rlim_max, testFileLimit)
  var ignore = sigaction()
  ignore.__sigaction_u.__sa_handler = SIG_IGN
  return setrlimit(RLIMIT_FSIZE, &limit) == 0 && sigaction(SIGXFSZ, &ignore, nil) == 0
}()

func temporaryDirectory() throws -> URL {
  precondition(capped, "The test process couldn't cap its file size")
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  return root
}

func sampleSnapshot(_ character: Character = "a") throws -> SnapshotID {
  try SnapshotID(String(repeating: String(character), count: 64))
}

/// A directory archive line with the fields of `directory.tsv.br`.
struct ArchiveLine {
  var category = 0
  var region = "13101"
  var name = "試験施設"
  var address = "東京都千代田区試験1-1"
  var phones = "03-5321-1111"
  var website = ""
  var provenance = 0
  var origin = "0"
  var confirmation = ""

  var text: String {
    [
      category.description, region, name, address, phones, website, provenance.description, origin,
      confirmation,
    ].joined(separator: "\t")
  }
}

func sampleHeaderObject(
  snapshot: Character = "a", counts: [String: Int] = ["13": 1]
) -> [String: Any] {
  [
    "snapshot": String(repeating: String(snapshot), count: 64),
    "generatedAt": "2026-10-30T00:00:00Z",
    "contacts": counts.values.reduce(0, +),
    "categories": [
      [
        "id": "library", "label": "図書館", "publisher": "試験の公開者", "license": "CC BY 4.0",
        "licenseUrl": "https://example.com/license",
      ],
      [
        "id": "medical", "label": "病院・診療所", "publisher": "試験の公開者", "license": "PDL-1.0",
        "licenseUrl": "https://example.com/license",
      ],
    ],
    "prefectures": (1...47).map {
      let code = String(format: "%02d", $0)
      return ["code": code, "name": $0 == 13 ? "東京都" : "県\($0)", "contacts": counts[code] ?? 0]
    },
    "municipalities": [["code": "13101", "prefectureCode": "13", "name": "千代田区"]],
    "sources": [["id": "test", "url": "https://example.com/source.csv", "title": "試験の資料"]],
    "provenances": [
      [
        "source": 0, "license": "CC BY 4.0", "licenseUrl": "https://example.com/license",
        "dataAsOf": "2026-10-01", "retrievedAt": "2026-10-29T00:00:00Z",
      ]
    ],
    "links": ["https://example.com/publication", "https://example.com/confirmation"],
  ]
}

func sampleHeader(snapshot: Character = "a", counts: [String: Int] = ["13": 1]) throws
  -> ArchiveHeader
{
  try JSONDecoder().decode(
    ArchiveHeader.self,
    from: JSONSerialization.data(
      withJSONObject: sampleHeaderObject(snapshot: snapshot, counts: counts))
  ).validated()
}

func archiveText(header: [String: Any], lines: [ArchiveLine]) throws -> Data {
  var data = Data("public-phonebook-directory\t1\n".utf8)
  data += try JSONSerialization.data(withJSONObject: header, options: [.sortedKeys])
  data += Data("\n".utf8)
  for line in lines.map(\.text).sorted(by: { Array($0.utf8).lexicographicallyPrecedes($1.utf8) }) {
    data += Data((line + "\n").utf8)
  }
  return data
}

func brotli(_ data: Data) throws -> Data {
  var destination = [UInt8](repeating: 0, count: data.count + 65_536)
  let source = [UInt8](data)
  let size = compression_encode_buffer(
    &destination, destination.count, source, source.count, nil, COMPRESSION_BROTLI)
  try #require(size > 0)
  return Data(destination.prefix(size))
}

func writeArchive(_ data: Data, in root: URL) throws -> URL {
  let url = root.appendingPathComponent(UUID().uuidString + ".br")
  try brotli(data).write(to: url)
  return url
}

func records(_ lines: [ArchiveLine], header: ArchiveHeader) throws -> [ArchiveRecord] {
  try lines.map { try ArchiveRecord(line: Data($0.text.utf8), header: header) }
}

@discardableResult
func publish(
  _ lines: [ArchiveLine], to store: SnapshotStore, snapshot: Character = "a",
  counts: [String: Int]? = nil
) async throws -> SnapshotManifest {
  let header = try sampleHeader(snapshot: snapshot, counts: counts ?? ["13": lines.count])
  try await store.begin(header: header)
  try await store.append(records(lines, header: header))
  return try await store.publish(at: Date())
}

/// A dataset listing with one archive in this app's format, which links the deltas when `deltas` is true.
func datasetsFixture(
  snapshot: String, contacts: Int, sha256: String, bytes: Int, url: String, deltas: Bool = false
) -> Data {
  let link = deltas ? ",\"datasetDeltas\":\"/api/dataset-deltas?snapshot=\(snapshot)\"" : ""
  return Data(
    """
    {"snapshot":"\(snapshot)","generatedAt":"2026-10-30","contacts":\(contacts),\
    "files":[{"file":"directory.tsv.br","format":"public-phonebook-directory/1",\
    "sha256":"\(sha256)","bytes":\(bytes),"url":"\(url)"}]\(link)}
    """.utf8)
}

let notFoundResponse = Data(
  "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".utf8)

func sha256Hex(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

/// The request targets that a test server received.
final class RequestLog: Sendable {
  private let paths = Mutex<[String]>([])
  func record(_ path: String) { paths.withLock { $0.append(path) } }
  var received: Set<String> { paths.withLock { Set($0) } }
  var ordered: [String] { paths.withLock { $0 } }
}
