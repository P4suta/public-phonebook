import PhonebookKit
import SwiftUI

/// Explains the app, its data, privacy, and how to reach the developer without leaving the app.
struct AboutScreen: View {
  let model: DirectoryModel
  let integration: IntegrationModel
  @Environment(\.openURL) private var openURL

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        Text("Public Phonebookについて").font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
        Text("役所や学校、病院などの電話番号をさがせます。")
        Text("iPhoneでは、アプリにある番号から電話がかかってきたとき、施設の名前が出ます。")

        section("無料で使えます")
        Text("プログラムも公開しています。")
        if let url = URL(string: "https://github.com/P4suta/public-phonebook") {
          NavigationLink {
            SettingsLinkConfirmation(page: ExternalPage(url: url, destination: .sourceCode))
          } label: {
            Label("プログラムを見る", systemImage: "arrow.up.right.square")
          }
          .buttonStyle(.borderless)
          .accessibilityIdentifier("source-code-link")
        }

        section("使い方")
        Text("検索欄に施設名または電話番号を入力してください。")
        Text("電話の相手を表示するには、「設定」で許可してください。")

        section("データについて")
        Text("国や自治体などが公開した電話番号を使います。")
        Text("新しいデータを自動で確認します。")
        Text("モバイルデータ通信や「省データモード」では、自動の受け取りを待ちます。")
        if let manifest = integration.manifest {
          Text("データの日付：\(manifest.dataDate.formatted(date: .long, time: .omitted))")
            .accessibilityIdentifier("data-date")
        }
        if integration.needsNewerApp {
          Text(IntegrationModel.newerAppLine).accessibilityIdentifier("newer-app")
        }
        NavigationLink {
          SourcesScreen(categories: model.categories)
        } label: {
          Label("データのもとを見る", systemImage: "info.circle")
        }
        .buttonStyle(.borderless)
        .accessibilityIdentifier("sources-link")

        section("データの収集")
        Text("ありません。").accessibilityIdentifier("privacy-collection")
        if let url = URL(string: "https://www.dial.page/privacy") {
          NavigationLink {
            SettingsLinkConfirmation(page: ExternalPage(url: url, destination: .other))
          } label: {
            Label("プライバシーについて読む", systemImage: "doc.text")
          }
          .buttonStyle(.borderless)
          .accessibilityIdentifier("privacy-policy-link")
        }

        section("お問い合わせ")
        Text("質問や不具合、情報のまちがいは、メールでお知らせください。")
        Text("あなたの電話番号や住所などは書かないでください。")
        Button {
          if let url = URL(string: "mailto:support@dial.page") { openURL(url) }
        } label: {
          Label("メールを送る", systemImage: "envelope")
        }
        .buttonStyle(.borderless)
        .accessibilityHint("メールアプリを開きます。")

        NavigationLink {
          LicenseScreen()
        } label: {
          Label("ライセンスを見る", systemImage: "doc.text")
        }
        .buttonStyle(.borderless)
        .accessibilityIdentifier("license-link")
        Text(
          "バージョン \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—")"
        )
        .font(.footnote)
      }
      .padding(20).frame(maxWidth: .infinity, alignment: .leading)
    }
    .navigationTitle("Public Phonebookについて").navigationBarTitleDisplayMode(.inline)
    .accessibilityIdentifier("about-content")
  }

  private func section(_ title: String) -> some View {
    Text(title).font(.title2.bold()).padding(.top, 12).accessibilityAddTraits(.isHeader)
  }
}

private struct SettingsLinkConfirmation: View {
  let page: ExternalPage
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        Text(page.message)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityLabel(page.destination.description)
          .accessibilityValue(page.hostLine)
          .accessibilityIdentifier("external-page-disclosure")
        Button("開く", systemImage: "arrow.up.right.square") {
          dismiss()
          openURL(page.url)
        }
        .buttonStyle(.borderedProminent)
        Button("キャンセル", role: .cancel) { dismiss() }
          .buttonStyle(.bordered)
      }
      .controlSize(.large)
      .padding(20)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .navigationTitle("ページを開きます").navigationBarTitleDisplayMode(.inline)
  }
}

/// Lists who publishes each category of the saved data and under which license.
struct SourcesScreen: View {
  let categories: [CategoryInfo]

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        Text("データの公開元と、使うときの決まりです。")
          .padding(.bottom, 12)
        ForEach(categories) { category in
          VStack(alignment: .leading, spacing: 4) {
            Text(category.label).bold()
            Text("\(category.publisher)・\(category.license)").font(.callout)
          }
          .padding(.vertical, 12)
          .accessibilityElement(children: .combine)
          Divider()
        }
      }.padding(20)
    }
    .navigationTitle("データのもと").navigationBarTitleDisplayMode(.inline)
  }
}

struct LicenseScreen: View {
  private var notices: String {
    guard let url = Bundle.main.url(forResource: "Lucide", withExtension: "txt"),
      let text = try? String(contentsOf: url, encoding: .utf8)
    else { return "ライセンスを開けませんでした。" }
    return text
  }

  var body: some View {
    ScrollView {
      Text(notices).font(.callout).textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading).padding(16)
    }
    .navigationTitle("ライセンス").navigationBarTitleDisplayMode(.inline)
    .accessibilityIdentifier("license-content")
  }
}
