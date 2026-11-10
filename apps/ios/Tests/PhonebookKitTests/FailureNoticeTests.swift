import Foundation
import PhonebookCore
import Testing

@testable import PhonebookKit

/// Every error that a first run or an update can throw, beside the step that it leaves to the person.
private let causes: [(error: any Error, step: Step)] = {
  let imports: [ImportError] = [
    .oversizedRecord, .invalidRecord, .invalidSnapshot, .unexpectedCount, .alreadyUpdating,
    .unavailableStorage, .activationUncertain, .projectionTooLarge,
  ]
  let services: [ServiceError] = [
    .invalidURL, .invalidResponse, .notFound, .snapshotChanged, .unsupportedFormat,
    .unavailable(retryAfter: nil), .unavailable(retryAfter: Date(timeIntervalSince1970: 0)),
    .http(500),
  ]
  let brotli: [BrotliError] = [.corrupt, .truncated, .lineTooLong, .unterminated]
  let network: [URLError.Code] = [
    .notConnectedToInternet, .networkConnectionLost, .timedOut, .cannotConnectToHost,
  ]
  var all: [(any Error, Step)] = []
  all += imports.map {
    ($0, $0 == .activationUncertain ? .reopen : .wait)
  }
  all += services.map { ($0, $0 == .unsupportedFormat ? .updateApp : .wait) }
  all += brotli.map { ($0, .wait) }
  all += network.map { (URLError($0), .wait) }
  all += BundleMismatch.Field.allCases.map { (BundleMismatch(field: $0), .wait) }
  all += DeltaAdmission.allCases.map { (DeltaRejection(admission: $0), .wait) }
  all.append(
    (
      SyncFailure(primary: ImportError.invalidRecord, cleanup: ImportError.unavailableStorage),
      .wait
    ))
  all.append((CocoaError(.fileReadCorruptFile), .wait))
  return all
}()

/// What the failure asks of the person during a first run, when no data is saved yet.
private enum Step: Equatable {
  case wait, updateApp, reopen
}

/// A first run names the step, and an automatic update speaks only when the person can update the app.
@Test func everyFailureLeavesOneStepWithOrWithoutSavedData() {
  for (error, step) in causes {
    for saved in [false, true] {
      let expected: FailureNotice =
        switch step {
        case .wait: saved ? .silent : .firstRunRetries
        case .updateApp: .appTooOld
        case .reopen: saved ? .silent : .reopen
        }
      #expect(FailureNotice.decide(error, saved: saved) == expected, "\(error), saved: \(saved)")
    }
  }
  let reached = Set(
    causes.flatMap { cause in [false, true].map { FailureNotice.decide(cause.error, saved: $0) } }
  )
  #expect(reached == Set(FailureNotice.allCases))
}
