import Foundation
import PhonebookCore
import PhonebookKit

/// Admits the archive that the build bundles with the app's own checks, and writes the entry that the app reads beside it.
/// Usage: BundledAdmission ARCHIVE EXPECTED_ENTRY OUTPUT_ENTRY
let arguments = CommandLine.arguments.dropFirst()
if arguments.first == "--search-bundle", arguments.count == 4 {
  let values = Array(arguments)
  do {
    let files = try SearchArtifactFiles.open(directory: URL(fileURLWithPath: values[1]))
    guard files.manifest.snapshot.rawValue == values[2], files.manifest.contacts == Int(values[3])
    else {
      throw RankingError.identityMismatch
    }
    _ = try files.admit()
    print(
      "PASS: search artifacts admit \(files.manifest.contacts) contacts from the declared snapshot")
    exit(0)
  } catch {
    FileHandle.standardError.write(
      Data("The bundled search artifacts failed admission: \(error)\n".utf8))
    exit(1)
  }
}
// With `--search-forms FORMS`, it requires the app's comparison form of every name in FORMS, which `tools/search-form-parity.ts` writes beside the website's form.
if arguments.first == "--search-forms", arguments.count == 2, let path = arguments.last {
  var compared = 0
  var differing: [String] = []
  do {
    let text = try String(contentsOf: URL(fileURLWithPath: path), encoding: .utf8)
    for line in text.split(separator: "\n") {
      let fields = line.split(separator: "\t", omittingEmptySubsequences: false)
      guard fields.count == 2 else { throw CocoaError(.fileReadCorruptFile) }
      compared += 1
      if SearchInput.searchForm(String(fields[0])) != String(fields[1]) {
        differing.append(String(fields[0]))
      }
    }
  } catch {
    FileHandle.standardError.write(Data("The search forms could not be read: \(error)\n".utf8))
    exit(1)
  }
  guard compared > 0, differing.isEmpty else {
    FileHandle.standardError.write(
      Data(
        "\(differing.count) of \(compared) names fold differently, such as \(differing.prefix(5))\n"
          .utf8))
    exit(1)
  }
  print("PASS: \(compared) names fold like the website")
  exit(0)
}
guard arguments.count == 3 else {
  FileHandle.standardError.write(
    Data("Usage: BundledAdmission ARCHIVE EXPECTED_ENTRY OUTPUT_ENTRY\n".utf8))
  exit(2)
}
let paths = arguments.map { URL(fileURLWithPath: $0) }
do {
  let entry = try JSONDecoder().decode(BundledEntry.self, from: Data(contentsOf: paths[1]))
  try await BundledDataset.admit(archive: paths[0], entry: entry)
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
  try encoder.encode(entry).write(to: paths[2], options: .atomic)
} catch let mismatch as BundleMismatch {
  FileHandle.standardError.write(
    Data("The bundled archive differs from its declaration in \(mismatch.field.rawValue)\n".utf8))
  exit(1)
} catch {
  FileHandle.standardError.write(Data("The bundled archive could not be admitted: \(error)\n".utf8))
  exit(1)
}
