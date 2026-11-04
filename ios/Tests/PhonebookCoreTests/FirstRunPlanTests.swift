import PhonebookCore
import Testing

private enum ListingKind: CaseIterable {
  case namesBundled, deltaFromBundled, noDeltaFromBundled, unreachable
}

private let sizes = [
  1, 999_999, 1_000_000, 374_905, DownloadSchedule.knownArchiveBytes, 268_435_456,
]

private func outcomes(_ kind: ListingKind) -> [ListingOutcome] {
  switch kind {
  case .namesBundled: sizes.map { .namesBundled(archiveBytes: $0) }
  case .deltaFromBundled:
    sizes.flatMap { delta in sizes.map { .deltaFromBundled(deltaBytes: delta, archiveBytes: $0) } }
  case .noDeltaFromBundled: sizes.map { .noDeltaFromBundled(archiveBytes: $0) }
  case .unreachable: [.unreachable]
  }
}

/// The decision record's table, one row for each pair of bundle state and listing outcome.
private func expected(_ bundle: BundleState, _ listing: ListingOutcome) -> FirstRunPlan {
  switch (bundle, listing) {
  case (.readable, .namesBundled):
    FirstRunPlan(transfer: .none, notice: .noTransfer, fallsBackToBundle: true)
  case (.readable, .deltaFromBundled(let delta, _)):
    FirstRunPlan(transfer: .delta, notice: .size(delta), fallsBackToBundle: true)
  case (.readable, .noDeltaFromBundled(let archive)):
    FirstRunPlan(transfer: .archive, notice: .size(archive), fallsBackToBundle: true)
  case (.readable, .unreachable):
    FirstRunPlan(transfer: .none, notice: .noTransfer, fallsBackToBundle: true)
  case (.missing, .namesBundled(let archive)):
    FirstRunPlan(transfer: .archive, notice: .size(archive), fallsBackToBundle: false)
  case (.missing, .deltaFromBundled(_, let archive)):
    FirstRunPlan(transfer: .archive, notice: .size(archive), fallsBackToBundle: false)
  case (.missing, .noDeltaFromBundled(let archive)):
    FirstRunPlan(transfer: .archive, notice: .size(archive), fallsBackToBundle: false)
  case (.missing, .unreachable):
    FirstRunPlan(
      transfer: .archive, notice: .size(DownloadSchedule.knownArchiveBytes),
      fallsBackToBundle: false)
  }
}

@Test(arguments: BundleState.allCases, ListingKind.allCases)
private func firstRunPlanFollowsTheRecordForEveryPair(_ bundle: BundleState, _ kind: ListingKind) {
  for listing in outcomes(kind) {
    let plan = FirstRunPlan.decide(bundle: bundle, listing: listing)
    #expect(plan == expected(bundle, listing), "\(bundle) \(listing)")
    // The no-transfer notice appears exactly when the run receives nothing.
    #expect((plan.transfer == .none) == (plan.notice == .noTransfer))
    // Only a readable bundle gives the run something to end with when a transfer fails.
    #expect(plan.fallsBackToBundle == (bundle == .readable))
  }
}

/// A delta never shows the archive's size, so the notice names what the person spends.
@Test func deltaNoticeNamesTheDeltaAndNotTheArchive() {
  let plan = FirstRunPlan.decide(
    bundle: .readable,
    listing: .deltaFromBundled(
      deltaBytes: 374_905, archiveBytes: DownloadSchedule.knownArchiveBytes))
  #expect(plan.notice == .size(374_905))
}
