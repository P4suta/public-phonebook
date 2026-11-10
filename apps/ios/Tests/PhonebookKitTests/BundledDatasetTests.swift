import Foundation
import PhonebookCore
import Testing

@testable import PhonebookKit

/// The provider's baseline archive and the entry that the build writes for it from the listing.
func bundledFixture(in root: URL) throws -> (archive: URL, entry: BundledEntry) {
  let entries = try corpus("baseline")
  let listing = try #require(entries.first { $0.path == "/api/datasets" })
  let datasets = try JSONDecoder().decode(DirectoryDatasets.self, from: listing.data)
  let file = try #require(datasets.files.compactMap(\.entry).first)
  let archiveEntry = try #require(entries.first { $0.path == file.url })
  let archive = root.appendingPathComponent("directory.tsv.br")
  try archiveEntry.data.write(to: archive)
  return (
    archive,
    BundledEntry(
      snapshot: datasets.snapshot, generatedAt: datasets.generatedAt, contacts: datasets.contacts,
      format: DatasetArchive.format, bytes: file.bytes, sha256: file.sha256)
  )
}

func writeEntry(_ entry: BundledEntry, in root: URL) throws -> URL {
  let url = root.appendingPathComponent("directory.json")
  try JSONEncoder().encode(entry).write(to: url)
  return url
}

private func entry(_ entry: BundledEntry, replacing field: BundleMismatch.Field) throws
  -> BundledEntry
{
  let other = try SnapshotID(String(repeating: "e", count: 64))
  return BundledEntry(
    snapshot: field == .snapshot ? other : entry.snapshot,
    generatedAt: field == .generatedAt ? "2000-01-01T00:00:00Z" : entry.generatedAt,
    contacts: field == .contacts ? entry.contacts + 1 : entry.contacts,
    format: field == .format ? "public-phonebook-directory/2" : entry.format,
    bytes: field == .bytes ? entry.bytes + 1 : entry.bytes,
    sha256: field == .sha256 ? other : entry.sha256)
}

private func mismatch(_ body: () async throws -> Void) async -> BundleMismatch.Field? {
  do {
    try await body()
    return nil
  } catch let mismatch as BundleMismatch {
    return mismatch.field
  } catch {
    return nil
  }
}

@Test func providerArchiveOpensAndPassesTheBuildAdmission() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let fixture = try bundledFixture(in: root)
  let bundle = try await BundledDataset.open(
    archive: fixture.archive, entry: writeEntry(fixture.entry, in: root))
  #expect(bundle.entry == fixture.entry)
  try await BundledDataset.admit(archive: fixture.archive, entry: fixture.entry)
}

/// Each entry field that the build repeats from the manifest names itself when it differs from the archive.
@Test(arguments: [
  BundleMismatch.Field.format, .bytes, .sha256, .snapshot, .contacts, .generatedAt,
])
func everyDifferingEntryFieldIsNamed(_ field: BundleMismatch.Field) async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let fixture = try bundledFixture(in: root)
  let changed = try entry(fixture.entry, replacing: field)
  #expect(
    await mismatch {
      _ = try await BundledDataset.open(
        archive: fixture.archive, entry: writeEntry(changed, in: root))
    } == field)
  #expect(
    await mismatch { try await BundledDataset.admit(archive: fixture.archive, entry: changed) }
      == field)
}

@Test func oneChangedArchiveByteFailsTheDigest() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let fixture = try bundledFixture(in: root)
  var bytes = try Data(contentsOf: fixture.archive)
  bytes[bytes.count / 2] ^= 0x01
  try bytes.write(to: fixture.archive)
  #expect(
    await mismatch {
      _ = try await BundledDataset.open(
        archive: fixture.archive, entry: writeEntry(fixture.entry, in: root))
    } == .sha256)
}

@Test func missingDamagedOrOversizedEntriesCountAsNoEntry() async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let fixture = try bundledFixture(in: root)
  let entry = root.appendingPathComponent("directory.json")
  #expect(
    await mismatch { _ = try await BundledDataset.open(archive: fixture.archive, entry: entry) }
      == .entry)
  for content in [
    Data("{".utf8), Data(repeating: 0x20, count: BundledDataset.maximumEntryBytes + 1),
  ] {
    try content.write(to: entry)
    #expect(
      await mismatch { _ = try await BundledDataset.open(archive: fixture.archive, entry: entry) }
        == .entry)
  }
  let missing = root.appendingPathComponent("missing.tsv.br")
  #expect(
    await mismatch {
      _ = try await BundledDataset.open(
        archive: missing, entry: writeEntry(fixture.entry, in: root))
    } == .bytes)
}

private enum ArchiveFault: CaseIterable {
  case signature, header, missingRow, notBrotli
}

/// Archives whose entry matches their bytes still fail on their format line, header, or rows.
@Test(arguments: ArchiveFault.allCases)
private func archiveFaultsBehindAMatchingDigestAreNamed(_ fault: ArchiveFault) async throws {
  let root = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: root) }
  let snapshot = try sampleSnapshot()
  var header = sampleHeaderObject(counts: ["13": 2])
  var text = try archiveText(header: header, lines: [ArchiveLine(), ArchiveLine(name: "二番目")])
  switch fault {
  case .signature:
    text = Data("public-phonebook-directory\t2".utf8) + text.drop { $0 != 0x0A }
  case .header:
    header["prefectures"] = []
    text = try archiveText(header: header, lines: [ArchiveLine(), ArchiveLine(name: "二番目")])
  case .missingRow:
    text = try archiveText(header: header, lines: [ArchiveLine()])
  case .notBrotli: break
  }
  let data = fault == .notBrotli ? text : try brotli(text)
  let archive = root.appendingPathComponent("directory.tsv.br")
  try data.write(to: archive)
  let entry = BundledEntry(
    snapshot: snapshot, generatedAt: "2026-10-30T00:00:00Z", contacts: 2,
    format: DatasetArchive.format, bytes: data.count, sha256: try SnapshotID(sha256Hex(data)))
  let opened = await mismatch {
    _ = try await BundledDataset.open(archive: archive, entry: writeEntry(entry, in: root))
  }
  let admitted = await mismatch { try await BundledDataset.admit(archive: archive, entry: entry) }
  switch fault {
  case .signature, .notBrotli:
    #expect(opened == .format)
    #expect(admitted == .format)
  case .header:
    #expect(opened == .header)
    #expect(admitted == .header)
  case .missingRow:
    #expect(opened == nil)
    #expect(admitted == .rows)
  }
}
