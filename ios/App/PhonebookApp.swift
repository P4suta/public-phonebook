import PhonebookKit
import SwiftUI

@main
struct PhonebookApp: App {
  @State private var directory: DirectoryModel?
  @State private var integration: IntegrationModel?
  @State private var startupError: String?

  init() {
    BackgroundRefresh.register()
    do {
      guard let url = URL(string: AppIdentity.apiOrigin) else { throw ServiceError.invalidURL }
      let api = try APIClient(origin: url, trace: SystemTraceSink())
      let store = try AppIdentity.store()
      #if PHONEBOOK_VERIFICATION_TOOLS
        _directory = State(initialValue: DirectoryModel(store: store, allowsForgivingSearch: true))
      #else
        _directory = State(initialValue: DirectoryModel(store: store))
      #endif
      _integration = State(initialValue: IntegrationModel(api: api, store: store))
    } catch { _startupError = State(initialValue: "アプリを開けませんでした。アプリを開き直してください。") }
  }

  var body: some Scene {
    WindowGroup {
      if let directory, let integration {
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
