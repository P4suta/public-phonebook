import PhonebookKit
import SwiftUI

@main
struct PhonebookApp: App {
  @State private var directory: DirectoryModel?
  @State private var integration: IntegrationModel?
  @State private var startupError: String?
  @State private var watch: WatchSearchReceiver?

  private static var measuresDevice: Bool {
    #if PHONEBOOK_VERIFICATION_TOOLS
      return ProcessInfo.processInfo.arguments.contains("--device-measurements")
    #else
      return false
    #endif
  }

  init() {
    BackgroundRefresh.register()
    if Self.measuresDevice { return }
    do {
      guard let url = URL(string: AppIdentity.apiOrigin) else { throw ServiceError.invalidURL }
      let api = try APIClient(origin: url, trace: SystemTraceSink())
      let store = try AppIdentity.store()
      _directory = State(initialValue: DirectoryModel(store: store))
      _integration = State(initialValue: IntegrationModel(api: api, store: store))
      _watch = State(initialValue: WatchSearchReceiver(store: store))
    } catch { _startupError = State(initialValue: "アプリを開けませんでした。アプリを開き直してください。") }
  }

  var body: some Scene {
    WindowGroup {
      if Self.measuresDevice {
        Rectangle().fill(.surface)
      } else if let directory, let integration {
        RootView(directory: directory, integration: integration)
          .tint(.ink)
      } else {
        Text(startupError ?? "アプリを開けませんでした。アプリを開き直してください。")
          .padding()
      }
    }
  }
}

private struct RootView: View {
  @Bindable var directory: DirectoryModel
  @Bindable var integration: IntegrationModel
  @AppStorage("onboardingComplete") private var onboarded = false
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    Group {
      if onboarded {
        SearchScreen(model: directory, integration: integration)
      } else {
        OnboardingScreen(integration: integration) { onboarded = true }
      }
    }
    .task { await integration.refresh() }
    .task(id: integration.manifest?.generation) { await directory.activate(integration.manifest) }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { Task { await integration.refresh() } }
    }
  }
}
