/// Whether the app bundle holds a directory archive that passed the checks of a download.
public enum BundleState: Sendable, Equatable, CaseIterable {
  case readable
  /// The bundle lacks the archive or its entry, or one of them failed a check.
  case missing
}

/// What the dataset listing says about the bundled snapshot, with the sizes that a transfer would take.
public enum ListingOutcome: Sendable, Equatable {
  /// The listing names the bundled snapshot.
  case namesBundled(archiveBytes: Int)
  /// The listing names another snapshot and lists a delta from the bundled one.
  case deltaFromBundled(deltaBytes: Int, archiveBytes: Int)
  /// The listing names another snapshot and lists no delta from the bundled one.
  case noDeltaFromBundled(archiveBytes: Int)
  /// The listing or its delta listing failed.
  case unreachable
}

/// The transfer that the first run starts after the person presses the start button, which may use any path.
public enum FirstRunTransfer: Sendable, Equatable {
  case none, delta, archive
}

/// The notice over the start button.
public enum WelcomeNotice: Sendable, Equatable {
  /// The data is in the app, and the first run needs no network.
  case noTransfer
  /// The first run receives this many bytes.
  case size(Int)
}

/// The first run's transfer and welcome notice, as the bundled-data decision record's table states them.
public struct FirstRunPlan: Sendable, Equatable {
  public let transfer: FirstRunTransfer
  public let notice: WelcomeNotice
  /// A failed listing, transfer, rebuild, or check ends the run with the bundled archive alone.
  public let fallsBackToBundle: Bool

  public init(transfer: FirstRunTransfer, notice: WelcomeNotice, fallsBackToBundle: Bool) {
    self.transfer = transfer
    self.notice = notice
    self.fallsBackToBundle = fallsBackToBundle
  }

  public static func decide(bundle: BundleState, listing: ListingOutcome) -> FirstRunPlan {
    switch (bundle, listing) {
    case (.readable, .namesBundled), (.readable, .unreachable):
      FirstRunPlan(transfer: .none, notice: .noTransfer, fallsBackToBundle: true)
    case (.readable, .deltaFromBundled(let delta, _)):
      FirstRunPlan(transfer: .delta, notice: .size(delta), fallsBackToBundle: true)
    case (.readable, .noDeltaFromBundled(let archive)):
      FirstRunPlan(transfer: .archive, notice: .size(archive), fallsBackToBundle: true)
    case (.missing, .namesBundled(let archive)), (.missing, .deltaFromBundled(_, let archive)),
      (.missing, .noDeltaFromBundled(let archive)):
      FirstRunPlan(transfer: .archive, notice: .size(archive), fallsBackToBundle: false)
    case (.missing, .unreachable):
      FirstRunPlan(
        transfer: .archive, notice: .size(DownloadSchedule.knownArchiveBytes),
        fallsBackToBundle: false)
    }
  }
}
