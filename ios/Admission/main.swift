import Foundation
import PhonebookKit

/// Admits the archive that the build bundles with the app's own checks, and writes the entry that the app reads beside it.
/// Usage: BundledAdmission ARCHIVE EXPECTED_ENTRY OUTPUT_ENTRY
let arguments = CommandLine.arguments.dropFirst()
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
