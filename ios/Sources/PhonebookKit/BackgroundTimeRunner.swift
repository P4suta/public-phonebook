import PhonebookCore

/// Begins and ends the background task that keeps the app running while an operation holds locks.
@MainActor
public protocol BackgroundTimePort {
  associatedtype Assertion
  /// Begins a background task and calls `expire` on the main actor when iOS asks for the time back.
  func begin(name: String, expire: @escaping @MainActor @Sendable () -> Void) -> Assertion
  func end(_ assertion: Assertion)
}

@MainActor
public enum BackgroundTimeRunner {
  /// Runs `operation` under a background task, cancels it when the task expires, and ends the task once it returns or throws.
  public static func run<Port: BackgroundTimePort, Value: Sendable>(
    _ port: Port, name: String, operation: @escaping @Sendable () async throws -> Value
  ) async throws -> Value {
    let task = ProtectedTask(port: port)
    task.assertion = port.begin(name: name) { [task] in task.apply(.expire) }
    let work = Task { try await operation() }
    task.cancelWork = { work.cancel() }
    // An expiry that arrived before the work existed still cancels it.
    if task.state == .expiring { work.cancel() }
    let result = await withTaskCancellationHandler {
      await work.result
    } onCancel: {
      work.cancel()
    }
    task.apply(.finish)
    return try result.get()
  }
}

/// Applies the background time decision to one background task and the work it protects.
@MainActor
private final class ProtectedTask<Port: BackgroundTimePort> {
  let port: Port
  var assertion: Port.Assertion?
  var cancelWork: (@Sendable () -> Void)?
  private(set) var state = BackgroundTime.running

  init(port: Port) { self.port = port }

  func apply(_ event: BackgroundTimeEvent) {
    let step = state.applying(event)
    state = step.next
    if step.cancel { cancelWork?() }
    if step.end, let assertion {
      self.assertion = nil
      port.end(assertion)
    }
  }
}
