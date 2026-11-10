import Foundation
import PhonebookCore
import XCTest

final class CallerProbeTests: XCTestCase {
  func testProbeKeepsTheDirectoryAndIsConsumedOnce() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let source = try directory(in: root, entries: 1200)
    let original = try Data(contentsOf: source)
    let pending = try VerificationNumberStore.prepareCallerProbe(in: root)
    XCTAssertTrue(FileManager.default.fileExists(atPath: pending.path))
    let consumed = try XCTUnwrap(VerificationNumberStore.takeCallerProbe(in: root))
    XCTAssertFalse(FileManager.default.fileExists(atPath: pending.path))
    XCTAssertNil(try VerificationNumberStore.takeCallerProbe(in: root))
    XCTAssertEqual(try Data(contentsOf: source), original)
    let held = { try CallerFile.Merged(national: CallerFile.Reader(url: consumed), extra: nil) }
    let wanted = { try CallerFile.Merged(national: CallerFile.Reader(url: source), extra: nil) }
    let counts = try CallerFile.countChanges(held: held, wanted: wanted)
    XCTAssertEqual(counts.removals, 1001)
    XCTAssertEqual(counts.additions, 1200)
    var cleared = false
    var added = 0
    let plan = try CallerFile.load(
      held: held, wanted: wanted,
      removeAll: { cleared = true },
      remove: { _ in XCTFail("The fixture must choose replacement") },
      add: { _, label in
        XCTAssertTrue(label.hasPrefix("Facility "))
        added += 1
      })
    XCTAssertEqual(plan, .full)
    XCTAssertTrue(cleared)
    XCTAssertEqual(added, 1200)
  }

  func testProbeRefusesAMissingOrSmallDirectory() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    XCTAssertThrowsError(try VerificationNumberStore.prepareCallerProbe(in: root)) {
      XCTAssertEqual($0 as? VerificationNumberStore.Failure, .missingDirectory)
    }
    _ = try directory(in: root, entries: 1000)
    XCTAssertThrowsError(try VerificationNumberStore.prepareCallerProbe(in: root)) {
      XCTAssertEqual($0 as? VerificationNumberStore.Failure, .insufficientCallerEntries)
    }
    XCTAssertNil(try VerificationNumberStore.takeCallerProbe(in: root))
  }

  private func directory(in root: URL, entries: Int) throws -> URL {
    let directory = root.appendingPathComponent("Directory")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let generation = UUID()
    let file = directory.appendingPathComponent(generation.uuidString + ".callers")
    let writer = try CallerFile.Writer(url: file)
    for index in 0..<entries {
      try writer.append(number: 81_111_000_000 + Int64(index), label: "Facility \(index)")
    }
    try writer.finish()
    try JSONEncoder().encode(["generation": generation.uuidString])
      .write(to: directory.appendingPathComponent("active.json"))
    return file
  }
}
