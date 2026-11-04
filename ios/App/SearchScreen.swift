import PhonebookCore
import PhonebookKit
import SwiftUI

struct SearchScreen: View {
  @Bindable var model: DirectoryModel
  @Bindable var integration: IntegrationModel
  @State private var path: [Contact] = []
  @State private var announced: [String] = []
  #if PHONEBOOK_VERIFICATION_TOOLS
    @State private var verification = VerificationNumberModel()
  #endif

  var body: some View {
    NavigationStack(path: $path) {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) { content }
          .padding(.horizontal, 16).padding(.vertical, 12)
          // The value names the typed query that the shown results answer, so a UI scenario never reads stale results.
          .accessibilityElement(children: .contain)
          .accessibilityIdentifier("search-results")
          .accessibilityValue(model.results?.input ?? "")
      }
      .scrollDismissesKeyboard(.interactively)
      .background(.white)
      .navigationTitle(AppIdentity.displayName)
      .navigationBarTitleDisplayMode(.inline)
      .toolbarBackground(.white, for: .navigationBar)
      .searchable(
        text: $model.query, placement: .navigationBarDrawer(displayMode: .always),
        prompt: "施設の名前や電話番号"
      )
      .onChange(of: model.query) { model.search() }
      .onSubmit(of: .search) { model.search() }
      .task(id: announcement) { await announce() }
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Menu {
            NavigationLink("Public Phonebookについて") {
              AboutScreen(model: model, integration: integration)
            }
            NavigationLink("設定") { SettingsScreen(model: integration) }
            #if PHONEBOOK_VERIFICATION_TOOLS
              NavigationLink("QA用の確認") {
                VerificationToolsScreen(model: verification, integration: integration)
              }
            #endif
          } label: {
            DesignIcon(name: "menu").frame(minWidth: 44, minHeight: 44)
          }
          .accessibilityLabel("メニュー")
          .accessibilityIdentifier("menu")
        }
      }
      .navigationDestination(for: Contact.self) { ContactScreen(contact: $0) }
    }
    .tint(.black)
  }

  /// What the total announcement depends on, so each keystroke restarts its wait.
  private var announcement: [String] {
    guard let results = model.results else { return [] }
    return [model.query, results.query, String(results.total)]
  }

  /// Announces the total once the results stop changing, after the same pause as the website's status.
  /// Returning from a contact shows the same results, so it announces nothing new.
  private func announce() async {
    let key = announcement
    guard !key.isEmpty else {
      announced = []
      return
    }
    guard key != announced else { return }
    do { try await Task.sleep(for: .milliseconds(600)) } catch { return }
    guard let results = model.results, !model.searching, announcement == key else { return }
    announced = key
    AccessibilityAnnouncement.post("\(results.total)件 見つかりました")
  }

  @ViewBuilder private var content: some View {
    if model.results == nil, !model.searching, !model.failed {
      VStack(alignment: .leading, spacing: 8) {
        Text("施設の名前か、電話番号を入れてください。")
        // Only a first download shows here, because monthly updates stay silent.
        if integration.receiving, let wait = integration.wait {
          FirstDownloadProgress(wait: wait, fraction: integration.fraction, showsHeading: true)
            .padding(.top, 16)
        }
        if !model.ready, integration.manifest == nil, let stopped = integration.stopped {
          VStack(alignment: .leading, spacing: 8) {
            Text("データの受け取りが止まりました").font(.headline)
            Text(stopped)
          }
          .padding(.top, 16)
          .accessibilityElement(children: .combine)
          .accessibilityIdentifier("sync-error")
        }
      }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("search-hint")
      if integration.callerStatus.promptsForSettings {
        Rectangle().fill(.black).frame(height: 1).padding(.top, 24)
        VStack(alignment: .leading, spacing: 12) {
          Text("病院や役所などから電話がかかってきたとき、iPhoneの画面に施設の名前を出せます。")
          Text("iPhoneの設定で、\(AppIdentity.displayName)を許可してください。")
          Button {
            integration.openCallerSettings()
          } label: {
            IconLabel(icon: "settings", text: "iPhoneの設定を開く")
          }
          .buttonStyle(MonoButtonStyle())
          .accessibilityIdentifier("caller-prompt-settings")
        }
        .padding(.top, 24)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("caller-prompt")
      }
    } else if model.failed {
      Text("さがせませんでした").font(.headline).accessibilityIdentifier("search-error")
      Button {
        model.retry()
      } label: {
        IconLabel(icon: "retry", text: "もう一度さがす")
      }
      .buttonStyle(MonoButtonStyle()).padding(.vertical, 12)
    } else if let results = model.results {
      #if PHONEBOOK_VERIFICATION_TOOLS
        if let entry = verification.match(model.query) {
          VerificationResult(entry: entry)
        } else if results.total == 0 {
          emptyResults
        }
      #else
        if results.total == 0 { emptyResults }
      #endif
      ForEach(results.groups) { group in groupView(group) }
    }
  }

  @ViewBuilder private var emptyResults: some View {
    Text("あてはまる施設は0件です").font(.title2.bold()).padding(.vertical, 12)
      .accessibilityAddTraits(.isHeader)
      .accessibilityIdentifier("empty-results")
    Text("名前の一部を入れるか、別の言葉でさがしてください。")
  }

  @ViewBuilder private func groupView(_ group: ResultGroup) -> some View {
    HStack(spacing: 6) {
      DesignIcon(name: IconCatalog.categories[group.key] ?? "file", size: 16)
      Text(group.label).bold()
      Text("\(group.total)件")
    }
    .font(.title3).padding(.top, 24).padding(.bottom, 8)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(group.label) \(group.total)件")
    .accessibilityAddTraits(.isHeader)
    .accessibilityIdentifier("group-\(group.key)")
    Rectangle().fill(.black).frame(height: 2)
    let visible = model.visible(group)
    ForEach(visible) { contact in
      ContactCard(contact: contact) { path.append(contact) }
        .onAppear {
          if contact.id == visible.last?.id, model.expanded(group) { model.more(group) }
        }
      Rectangle().fill(.black).frame(height: 1)
    }
    if model.expandable(group), !model.expanded(group) {
      Button {
        model.more(group)
      } label: {
        IconLabel(icon: "chevron-down", text: "\(group.label)をもっと見る")
      }
      .buttonStyle(MonoButtonStyle())
      .padding(.vertical, 12)
      .accessibilityIdentifier("more-\(group.key)")
    }
  }
}

private struct ContactCard: View {
  let contact: Contact
  let detail: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(contact.name).font(.title3.bold()).multilineTextAlignment(.leading)
        .accessibilityAddTraits(.isHeader)
      if !contact.region.isEmpty {
        Text(contact.region).font(.callout).accessibilityIdentifier("contact-region")
      }
      ForEach(contact.phones, id: \.e164) { PhoneActions(phone: $0) }
      // The one control that opens the details names its action, so the name stays plain heading text.
      Button(action: detail) {
        IconLabel(icon: "next", text: detailLabel)
      }
      .buttonStyle(MonoButtonStyle())
      .accessibilityLabel("\(contact.name)の\(detailLabel)")
      .accessibilityIdentifier("contact-detail")
    }.padding(.vertical, 16)
  }

  /// Names what the details add to the card in plain words: the address, or more about the facility when it has none.
  private var detailLabel: String {
    contact.address.isEmpty ? "くわしい情報を見る" : "住所などを見る"
  }
}
