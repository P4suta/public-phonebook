import PhonebookKit
import UIKit

/// Asks UIKit for background execution time, as `beginBackgroundTask(withName:expirationHandler:)` documents.
struct ApplicationBackgroundTime: BackgroundTimePort {
  func begin(name: String, expire: @escaping @MainActor @Sendable () -> Void)
    -> UIBackgroundTaskIdentifier
  {
    UIApplication.shared.beginBackgroundTask(withName: name, expirationHandler: expire)
  }

  func end(_ assertion: UIBackgroundTaskIdentifier) {
    // UIKit returns an invalid identifier when it grants no time, and that identifier has nothing to end.
    guard assertion != .invalid else { return }
    UIApplication.shared.endBackgroundTask(assertion)
  }
}
