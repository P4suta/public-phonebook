import PhonebookCore
import PhonebookKit
import SwiftUI

enum SearchRoute: Hashable {
  case contact(Contact)
  case source(Contact)
  case about, settings, sources, license
  #if PHONEBOOK_VERIFICATION_TOOLS
    case verification
  #endif
}

struct SearchScreen: View {
  @Bindable var model: DirectoryModel
  @Bindable var integration: IntegrationModel
  @ScaledMetric(relativeTo: .body) private var minimumColumnWidth: CGFloat = 320
  @ScaledMetric(relativeTo: .body) private var idealColumnWidth: CGFloat = 420
  @State private var path: [SearchRoute] = []
  @State private var showsColumns = false
  @State private var announced: [String] = []
  @FocusState private var searchIsFocused: Bool
  #if PHONEBOOK_VERIFICATION_TOOLS
    @State private var verification = VerificationNumberModel()
  #endif

  var body: some View {
    GeometryReader { geometry in
      Group {
        if showsColumns {
          HStack(spacing: 0) {
            NavigationStack { searchContent }
              .frame(
                width: max(minimumColumnWidth, min(idealColumnWidth, geometry.size.width * 0.44)))
            Rectangle().fill(.ink).frame(width: 1)
            detailStack
          }
        } else {
          NavigationStack(path: searchPath) {
            searchContent
              .navigationDestination(for: SearchRoute.self, destination: detailDestination)
          }
        }
      }
      .onChange(of: geometry.size.width >= minimumColumnWidth * 2 + 1, initial: true) {
        _, fits in
        showsColumns = fits
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
        case .contact = path.first
      {
        path = []
      }
    }
    .task(id: announcement) { await announce() }
  }

  private var searchPath: Binding<[SearchRoute]> {
    Binding(
      get: { path },
      set: { routes in
        if !showsColumns {
          path = routes
        }
      }
    )
  }

  private var searchContent: some View {
    VStack(spacing: 0) {
      searchField
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
    }
    .scrollDismissesKeyboard(.interactively)
    .background(.surface)
    .navigationTitle("検索")
    .navigationBarTitleDisplayMode(.inline)
    .toolbarBackground(.surface, for: .navigationBar)
    .toolbarBackgroundVisibility(.visible, for: .navigationBar)
  }

  private var detailStack: some View {
    NavigationStack(path: nestedPath) {
      Group {
        if let selected = path.first {
          detailDestination(selected)
        } else {
          ContentUnavailableView("施設を選んでください", image: "search")
            .background(.surface)
        }
      }
      .navigationDestination(for: SearchRoute.self, destination: detailDestination)
    }
  }

  private var nestedPath: Binding<[SearchRoute]> {
    Binding(
      get: { Array(path.dropFirst()) },
      set: { remaining in
        if showsColumns {
          path = path.first.map { [$0] + remaining } ?? []
        }
      }
    )
  }

  @ViewBuilder private func detailDestination(_ route: SearchRoute) -> some View {
    switch route {
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

  private func select(_ route: SearchRoute) {
    searchIsFocused = false
    path = [route]
  }

  private func clearSearch() {
    searchIsFocused = false
    path = []
    model.query = ""
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
          Text("電話の相手を表示できます。")
          Text("設定で「\(AppIdentity.displayName)」を許可してください。")
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
        Text("結果は100件まで表示します。").padding(.top, 12)
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
    Text("別の言葉でさがしてください。")
  }

}

private struct ContactCard: View {
  let contact: Contact
  let detail: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      VStack(alignment: .leading, spacing: 10) {
        Text(contact.name).font(.title3.bold()).multilineTextAlignment(.leading)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("contact-name")
        if !contact.region.isEmpty {
          Text(contact.region).font(.callout).accessibilityIdentifier("contact-region")
        }
      }
      .accessibilityElement(children: .combine)
      .accessibilityAddTraits(.isHeader)
      .accessibilityIdentifier("contact-summary")
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
