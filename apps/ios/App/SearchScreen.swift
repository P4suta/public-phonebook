import PhonebookCore
import PhonebookKit
import SwiftUI

enum SearchDetailRoute: Hashable {
  case source(Contact)
  case sources, license
}

struct SearchScreen: View {
  @Bindable var model: DirectoryModel
  @Bindable var integration: IntegrationModel
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass
  @ScaledMetric(relativeTo: .body) private var minimumColumnWidth: CGFloat = 320
  @State private var destination: Destination?
  @State private var detailPath: [SearchDetailRoute] = []
  @State private var compactColumn: NavigationSplitViewColumn = .sidebar
  @State private var announced: [String] = []
  @FocusState private var searchIsFocused: Bool
  #if PHONEBOOK_VERIFICATION_TOOLS
    @State private var verification = VerificationNumberModel()
  #endif

  var body: some View {
    Group {
      if horizontalSizeClass == .regular {
        NavigationSplitView(preferredCompactColumn: $compactColumn) {
          searchContent
            .navigationSplitViewColumnWidth(
              min: dynamicTypeSize.isAccessibilitySize ? 420 : 360,
              ideal: dynamicTypeSize.isAccessibilitySize ? 500 : 420, max: 600
            )
        } detail: {
          detailStack
        }
        .navigationSplitViewStyle(.balanced)
      } else {
        GeometryReader { geometry in
          if geometry.size.width >= minimumColumnWidth * 2 + 1 {
            HStack(spacing: 0) {
              NavigationStack { searchContent }
                .frame(width: max(minimumColumnWidth, geometry.size.width * 0.44))
              Rectangle().fill(.ink).frame(width: 1)
              detailStack
            }
          } else {
            NavigationStack(path: $detailPath) {
              Group {
                if destination == nil {
                  searchContent
                } else {
                  detailContent
                    .toolbar {
                      ToolbarItem(placement: .topBarLeading) {
                        Button("検索にもどる", systemImage: "chevron.backward", action: returnToSearch)
                          .accessibilityIdentifier("return-to-search")
                      }
                    }
                }
              }
              .navigationDestination(for: SearchDetailRoute.self, destination: detailDestination)
            }
          }
        }
      }
    }
    .tint(.ink)
    .onChange(of: model.query) {
      let submitted = model.query.components(separatedBy: .newlines).joined(separator: " ")
      if submitted != model.query {
        model.query = submitted.trimmingCharacters(in: .whitespacesAndNewlines)
        searchIsFocused = false
        return
      }
      model.search()
      if model.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
        case .contact = destination
      {
        detailPath = []
        destination = nil
      }
    }
    .task(id: announcement) { await announce() }
  }

  private var searchContent: some View {
    ScrollViewReader { reader in
      List {
        content
          .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
          .listRowSeparator(.hidden)
          .listRowBackground(Rectangle().fill(.surface))
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .accessibilityIdentifier("search-results")
      .accessibilityValue(model.results?.input ?? "")
      .onChange(of: model.results?.input) {
        reader.scrollTo(model.results?.groups.first?.key ?? "search-hint", anchor: .top)
      }
    }
    .safeAreaInset(edge: .top, spacing: 0) { searchField }
    .scrollDismissesKeyboard(.interactively)
    .background(.surface)
    .navigationTitle("検索")
    .navigationBarTitleDisplayMode(.inline)
    .toolbarBackground(.surface, for: .navigationBar)
    .toolbarBackgroundVisibility(.visible, for: .navigationBar)
  }

  private var detailStack: some View {
    NavigationStack(path: $detailPath) {
      detailContent
        .navigationDestination(for: SearchDetailRoute.self, destination: detailDestination)
    }
  }

  @ViewBuilder private func detailDestination(_ route: SearchDetailRoute) -> some View {
    switch route {
    case .source(let contact): SourceScreen(contact: contact)
    case .sources: SourcesScreen(categories: model.categories)
    case .license: LicenseScreen()
    }
  }

  private var searchField: some View {
    HStack(spacing: 8) {
      HStack(spacing: 8) {
        DesignIcon(name: "search")
        TextField(
          "施設の名前", text: $model.query, prompt: Text("名前").foregroundStyle(.ink),
          axis: .vertical
        )
        .textFieldStyle(.plain)
        .font(.body)
        .lineLimit(1...3)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .submitLabel(.search)
        .focused($searchIsFocused)
        .onSubmit {
          searchIsFocused = false
          model.search()
        }
        .frame(minHeight: 44)
        .accessibilityAddTraits(.isSearchField)
        .accessibilityLabel("施設の名前")
        .accessibilityIdentifier("search-field")
      }
      .padding(.horizontal, 12)
      .frame(maxHeight: .infinity)
      .overlay { Rectangle().strokeBorder(.ink, lineWidth: 2) }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("search-field-border")
      if !model.query.isEmpty {
        Button {
          model.query = ""
          searchIsFocused = true
        } label: {
          Label("検索を消す", systemImage: "xmark")
            .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
        }
        .buttonStyle(MonoButtonStyle(iconOnly: true))
        .accessibilityIdentifier("clear-search-field")
      }
      Menu {
        Button("Public Phonebookについて") { select(.about) }
        Button("設定") { select(.settings) }
        #if PHONEBOOK_VERIFICATION_TOOLS
          Button("QA用の確認") { select(.verification) }
        #endif
      } label: {
        DesignIcon(name: "menu").frame(minWidth: 44, minHeight: 44)
      }
      .buttonStyle(MonoButtonStyle(iconOnly: true))
      .accessibilityLabel("メニュー")
      .accessibilityIdentifier("menu")
    }
    .fixedSize(horizontal: false, vertical: true)
    .foregroundStyle(.ink)
    .padding(16)
    .background(.surface)
  }

  @ViewBuilder private var detailContent: some View {
    switch destination {
    case .contact(let contact):
      ContactScreen(contact: contact)
        .toolbar {
          ToolbarItem(placement: .topBarTrailing) {
            Button("検索を消す", systemImage: "xmark", action: clearSearch)
              .labelStyle(.titleAndIcon)
              .accessibilityIdentifier("clear-search")
          }
        }
    case .about: AboutScreen(model: model, integration: integration)
    case .settings: SettingsScreen(model: integration)
    #if PHONEBOOK_VERIFICATION_TOOLS
      case .verification:
        VerificationToolsScreen(model: verification, integration: integration)
    #endif
    case nil:
      ContentUnavailableView("施設を選んでください", image: "search")
        .background(.surface)
    }
  }

  private enum Destination: Hashable {
    case contact(Contact)
    case about, settings
    #if PHONEBOOK_VERIFICATION_TOOLS
      case verification
    #endif
  }

  private func select(_ destination: Destination) {
    searchIsFocused = false
    detailPath = []
    self.destination = destination
    compactColumn = .detail
  }

  private func clearSearch() {
    searchIsFocused = false
    detailPath = []
    model.query = ""
    destination = nil
    compactColumn = .sidebar
  }

  private func returnToSearch() {
    detailPath = []
    destination = nil
    compactColumn = .sidebar
  }

  /// What the total announcement depends on, so each keystroke restarts its wait.
  private var announcement: [String] {
    guard let results = model.results else { return [] }
    return [model.query, results.input, String(results.total)]
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
    if model.loading {
      ProgressView("検索の準備をしています").tint(.ink)
        .accessibilityIdentifier("search-preparing")
    } else if model.results == nil, !model.searching, !model.failed {
      VStack(alignment: .leading, spacing: 8) {
        Text("施設の名前を入れてください。")
        // Only a first download shows here, because automatic updates stay silent.
        if integration.receiving, let wait = integration.wait {
          FirstDownloadProgress(
            wait: wait, fraction: integration.fraction, preparing: integration.preparing,
            showsHeading: true
          )
          .padding(.top, 16)
        }
        if integration.needsNewerApp {
          Text(IntegrationModel.newerAppLine).padding(.top, 16)
            .accessibilityIdentifier("newer-app")
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
      .id("search-hint")
      if integration.callerStatus.promptsForSettings {
        VStack(alignment: .leading, spacing: 12) {
          Text("病院や役所などから電話がかかってきたとき、画面に施設の名前を出せます。")
          Text("設定で、\(AppIdentity.displayName)を許可してください。")
          Button {
            integration.openCallerSettings()
          } label: {
            IconLabel(icon: "settings", text: "設定を開く")
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
    } else if model.searching {
      ProgressView("さがしています").tint(.ink)
        .accessibilityIdentifier("search-progress")
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
      if results.limited {
        Text("関連度順に100件まで表示します。").padding(.top, 12)
          .accessibilityIdentifier("search-limit")
      }
      ForEach(results.groups) { group in groupView(group) }
    }
  }

  @ViewBuilder private func groupView(_ group: ResultGroup) -> some View {
    let visible = model.visible(group)
    Section {
      ForEach(visible) { contact in
        ContactCard(contact: contact) { select(.contact(contact)) }
          .onAppear {
            if contact.id == visible.last?.id, model.expanded(group) { model.more(group) }
          }
      }
      if model.expandable(group), !model.expanded(group) {
        Button {
          model.more(group)
        } label: {
          IconLabel(icon: "chevron-down", text: "\(group.label)をもっと見る")
        }
        .buttonStyle(MonoButtonStyle())
        .padding(.vertical, 12)
        .disabled(model.loadingMore)
        .accessibilityIdentifier("more-\(group.key)")
      }
    } header: {
      HStack(spacing: 6) {
        DesignIcon(name: IconCatalog.categories[group.key] ?? "file", size: 16)
        Text(group.label).bold()
        Text("\(group.total)件")
      }
      .font(.title3).foregroundStyle(.ink).textCase(nil)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(.surface)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("\(group.label) \(group.total)件")
      .accessibilityAddTraits(.isHeader)
      .accessibilityIdentifier("group-\(group.key)")
      .id(group.key)
    }
  }

  @ViewBuilder private var emptyResults: some View {
    Text("あてはまる施設は0件です").font(.title2.bold()).padding(.vertical, 12)
      .accessibilityAddTraits(.isHeader)
      .accessibilityIdentifier("empty-results")
    Text("名前の一部を入れるか、別の言葉でさがしてください。")
  }

}

private struct ContactCard: View {
  let contact: Contact
  let detail: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(contact.name).font(.title3.bold()).multilineTextAlignment(.leading)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("contact-name")
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
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("result-card")
  }

  /// Names what the details add to the card in plain words: the address, or more about the facility when it has none.
  private var detailLabel: String {
    contact.address.isEmpty ? "くわしい情報を見る" : "住所などを見る"
  }
}
