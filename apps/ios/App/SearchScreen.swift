import PhonebookCore
import PhonebookKit
import SwiftUI

enum SearchRoute: Hashable {
  case contact(Contact)
  case source(Contact)
}

struct SearchScreen: View {
  @Bindable var model: DirectoryModel
  @Bindable var integration: IntegrationModel
  private let minimumColumnWidth: CGFloat = 320
  private let idealColumnWidth: CGFloat = 420
  @State private var path: [SearchRoute] = []
  @State private var compactColumn = NavigationSplitViewColumn.sidebar
  @State private var announced: [String] = []
  @State private var showsSettings = false
  @FocusState private var searchIsFocused: Bool
  #if PHONEBOOK_VERIFICATION_TOOLS
    @State private var verification = VerificationNumberModel()
  #endif

  var body: some View {
    GeometryReader { geometry in
      NavigationSplitView(
        columnVisibility: .constant(.all), preferredCompactColumn: $compactColumn
      ) {
        searchContent
          .toolbar(removing: .sidebarToggle)
          .navigationSplitViewColumnWidth(
            min: minimumColumnWidth, ideal: idealColumnWidth, max: idealColumnWidth)
      } detail: {
        detailStack
          .navigationSplitViewColumnWidth(
            min: minimumColumnWidth, ideal: idealColumnWidth)
      }
      .navigationSplitViewStyle(.balanced)
      .environment(
        \.horizontalSizeClass,
        geometry.size.width >= minimumColumnWidth * 2 + 1 ? .regular : .compact
      )
    }
    .accessibilityHidden(showsSettings)
    .sheet(isPresented: $showsSettings) {
      NavigationStack { SettingsScreen(model: integration, directory: model) }
    }
    #if PHONEBOOK_VERIFICATION_TOOLS
      .environment(verification)
    #endif
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
        compactColumn = .sidebar
      }
    }
    .task(id: announcement) { await announce() }
  }

  private var searchContent: some View {
    ScrollViewReader { reader in
      List(selection: selection) {
        content
      }
      .listStyle(.plain)
      .scrollDismissesKeyboard(.interactively)
      .accessibilityIdentifier("search-results")
      .accessibilityValue(model.results?.input ?? "")
      .onChange(of: model.results?.input) {
        reader.scrollTo(model.results?.groups.first?.key ?? "search-hint", anchor: .top)
      }
    }
    .navigationTitle("検索")
    .searchable(
      text: $model.query, placement: .navigationBarDrawer(displayMode: .always),
      prompt: "施設名または電話番号"
    )
    .searchFocused($searchIsFocused)
    .searchPresentationToolbarBehavior(.avoidHidingContent)
    .autocorrectionDisabled()
    .textInputAutocapitalization(.never)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button("設定", systemImage: "gearshape") { showsSettings = true }
          .accessibilityIdentifier("open-settings")
      }
    }
  }

  private var selection: Binding<Contact?> {
    Binding(
      get: {
        guard case .contact(let contact) = path.first else { return nil }
        return contact
      },
      set: { contact in
        if let contact {
          if path.first != .contact(contact) { select(contact) }
        } else {
          path = []
          compactColumn = .sidebar
        }
      })
  }

  private var detailStack: some View {
    NavigationStack(path: nestedPath) {
      Group {
        if let selected = path.first {
          detailDestination(selected)
        } else {
          ContentUnavailableView("施設を選んでください", systemImage: "magnifyingglass")
        }
      }
      .navigationDestination(for: SearchRoute.self, destination: detailDestination)
    }
  }

  private var nestedPath: Binding<[SearchRoute]> {
    Binding(
      get: { Array(path.dropFirst()) },
      set: { remaining in
        path = path.first.map { [$0] + remaining } ?? []
      }
    )
  }

  @ViewBuilder private func detailDestination(_ route: SearchRoute) -> some View {
    switch route {
    case .contact(let contact):
      ContactScreen(contact: contact)
        .id(contact.id)
        .toolbar {
          ToolbarItem(placement: .topBarTrailing) {
            Button("検索を消す", systemImage: "xmark", action: clearSearch)
              .labelStyle(.titleAndIcon)
              .accessibilityIdentifier("clear-search")
          }
        }
    case .source(let contact): SourceScreen(contact: contact)
    }
  }

  private func select(_ contact: Contact) {
    searchIsFocused = false
    path = [.contact(contact)]
    compactColumn = .detail
  }

  private func clearSearch() {
    searchIsFocused = false
    path = []
    compactColumn = .sidebar
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
      ProgressView("検索の準備をしています")
        .accessibilityIdentifier("search-preparing")
    } else if model.results == nil, !model.searching, !model.failed {
      VStack(alignment: .leading, spacing: 8) {
        Text("施設名または電話番号を入力してください。")
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
            Label("設定を開く", systemImage: "gearshape")
              .fixedSize(horizontal: false, vertical: true)
              .frame(minHeight: 44, alignment: .leading)
              .contentShape(Rectangle())
          }
          .buttonStyle(.borderless)
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
        Label("もう一度さがす", systemImage: "arrow.clockwise")
      }
      .buttonStyle(.borderless).padding(.vertical, 12)
    } else if model.searching {
      ProgressView("さがしています")
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
    Section {
      ForEach(model.visible(group)) { contact in
        FacilityRow(contact: contact) { select(contact) }
          .tag(contact)
      }
      if model.expandable(group) {
        Button("\(group.label)をもっと見る", systemImage: "chevron.down") { model.more(group) }
          .disabled(model.loadingMore)
          .accessibilityIdentifier("more-\(group.key)")
      }
    } header: {
      HStack {
        DesignIcon(name: IconCatalog.categories[group.key] ?? "file", size: 16)
        Text("\(group.label) \(group.total)件")
      }
      .foregroundStyle(TintShapeStyle())
      .textCase(nil)
      .accessibilityElement(children: .combine)
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

private struct FacilityRow: View {
  let contact: Contact
  let showDetails: () -> Void

  private var summary: String {
    if contact.phones.count == 1, let phone = contact.phones.first { return phone.nationalDisplay }
    return "電話番号\(contact.phones.count)件"
  }

  var body: some View {
    HStack(spacing: 8) {
      Button(action: showDetails) {
        VStack(alignment: .leading, spacing: 3) {
          Text(contact.name).font(.headline)
          if !contact.region.isEmpty { Text(contact.region).font(.subheadline) }
          Text(summary).font(.subheadline).monospacedDigit()
        }
        .multilineTextAlignment(.leading)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(
        [contact.name, contact.region, summary].filter { !$0.isEmpty }.joined(separator: "、")
      )
      .accessibilityHint("施設の情報を表示します。")
      .accessibilityIdentifier("contact-detail")
      if let phone = contact.phones.first {
        if contact.phones.count == 1 {
          CallButton(phone: phone, iconOnly: true)
        } else {
          Menu {
            ForEach(contact.phones, id: \.e164) { number in
              CallButton(phone: number, showNumber: true)
            }
          } label: {
            Image(systemName: "phone").frame(minWidth: 44, minHeight: 44)
              .contentShape(Rectangle())
          }
          .buttonStyle(.borderless)
          .accessibilityLabel("\(contact.name)の電話番号を選ぶ")
          .accessibilityIdentifier("choose-number")
        }
      }
    }
    .accessibilityElement(children: .contain)
  }
}
