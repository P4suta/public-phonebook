import PhonebookCore
import PhonebookKit
import SwiftUI

struct SearchScreen: View {
  @Bindable var model: DirectoryModel
  @Bindable var integration: IntegrationModel
  @State private var path: [Contact] = []

  var body: some View {
    NavigationStack(path: $path) {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) { content }
          .padding(.horizontal, 16).padding(.vertical, 12)
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
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Menu {
            NavigationLink("Public Phonebookについて") { AboutScreen(model: model) }
            NavigationLink("設定") { SettingsScreen(model: integration) }
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

  @ViewBuilder private var content: some View {
    if model.results == nil, !model.searching, !model.failed {
      VStack(alignment: .leading, spacing: 8) {
        Text("施設や窓口の名前か、電話番号を入れてください。")
        Text("名前の一部でも、さがせます。")
        if integration.progress != nil {
          SaveProgress(percent: integration.percent, remaining: integration.remainingSeconds)
            .padding(.top, 16)
        }
        if !model.ready, integration.progress == nil, integration.manifest == nil,
          let problem = integration.problem
        {
          Text(problem).padding(.top, 16).accessibilityIdentifier("sync-error")
        }
      }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("search-hint")
    } else if model.failed {
      Text("さがせませんでした").font(.headline).accessibilityIdentifier("search-error")
      Button {
        model.retry()
      } label: {
        IconLabel(icon: "retry", text: "もう一度さがす")
      }
      .buttonStyle(MonoButtonStyle()).padding(.vertical, 12)
    } else if let results = model.results {
      Text("\(results.total)件 見つかりました").font(.headline)
        .accessibilityIdentifier("directory-total")
      if results.total == 0 {
        Text("施設や窓口が見つかりませんでした").font(.title2.bold()).padding(.vertical, 12)
        Text("名前の一部だけを入れてみてください。")
      }
      ForEach(results.groups) { group in groupView(group) }
    }
  }

  @ViewBuilder private func groupView(_ group: ResultGroup) -> some View {
    HStack(spacing: 6) {
      DesignIcon(name: IconCatalog.categories[group.key] ?? "file", size: 16)
      Text(group.label).bold()
      Text("\(group.total)件")
    }
    .font(.title3).padding(.top, 24).padding(.bottom, 8)
    .accessibilityElement(children: .combine).accessibilityAddTraits(.isHeader)
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
      Button(action: detail) {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(contact.name).font(.title3.bold()).multilineTextAlignment(.leading)
          DesignIcon(name: "next", size: 16)
        }
      }
      .buttonStyle(.plain)
      .accessibilityLabel("\(contact.name)の情報を見る")
      .accessibilityIdentifier("contact-detail")
      if !contact.region.isEmpty {
        Text(contact.region).font(.callout).accessibilityIdentifier("contact-region")
      }
      ForEach(contact.phones, id: \.e164) { PhoneActions(phone: $0, name: contact.name) }
    }.padding(.vertical, 16)
  }
}
