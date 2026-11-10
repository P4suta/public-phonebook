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
        Text("病院や役所などから電話がかかってきたとき、画面に施設の名前が出ます。")
        Text("アプリに番号がある施設の名前が出ます。")
        Text("学校や役所、病院などの電話番号を、名前でさがせるアプリです。")
        Text("国や自治体などが公開しているデータをもとにしています。")
        Text("国や自治体の公式アプリではありません。")

        section("無料で使えます")
        Text("アプリもウェブサイトも、無料で使えます。")
        Text("プログラムの中身を公開する「オープンソース」です。")
        Text("決まりにそって、だれでも使ったり、作りかえたりできます。")
        if let url = URL(string: "https://github.com/P4suta/public-phonebook") {
          ExternalLink(url: url, destination: .sourceCode) {
            IconLabel(icon: "external", text: "プログラムと決まりを見る")
          }
          .buttonStyle(MonoButtonStyle())
          .accessibilityIdentifier("source-code-link")
        }

        section("使い方")
        Text("検索欄に施設の名前を入れます。")
        Text("電話の相手を表示するには、「設定」で許可してください。")
        Text("電話をかけたり受けたりするのは、いつもの電話アプリです。")

        section("データについて")
        Text("全国の施設が公開した電話番号のデータを、アプリの中に受け取って使います。")
        Text("新しいデータが出ると、自動で受け取ります。")
        Text("モバイルデータ通信や省データモードのときは、ほかの回線につながるまで待ちます。")
        if let manifest = integration.manifest {
          Text("データの日付：\(manifest.dataDate.formatted(date: .long, time: .omitted))")
            .accessibilityIdentifier("data-date")
        }
        if integration.needsNewerApp {
          Text(IntegrationModel.newerAppLine).accessibilityIdentifier("newer-app")
        }
        NavigationLink(value: SearchDetailRoute.sources) {
          IconLabel(icon: "info", text: "データのもとを見る")
        }
        .buttonStyle(MonoButtonStyle())
        .accessibilityIdentifier("sources-link")

        section("データの収集")
        Text("ありません。").accessibilityIdentifier("privacy-collection")
        if let url = URL(string: "https://www.dial.page/privacy") {
          ExternalLink(url: url, destination: .other) {
            IconLabel(icon: "file", text: "プライバシーについて読む")
          }
          .buttonStyle(MonoButtonStyle())
          .accessibilityIdentifier("privacy-policy-link")
        }

        section("開発者に声を伝える")
        Text("感想や使い方の質問、不具合、情報のまちがいは、メールで送ってください。")
        Text("あなたの電話番号や住所などは書かないでください。")
        Button {
          if let url = URL(string: "mailto:support@dial.page") { openURL(url) }
        } label: {
          IconLabel(icon: "messages-square", text: "開発者にメールを送る")
        }
        .buttonStyle(MonoButtonStyle())
        .accessibilityHint("メールアプリを開きます。")

        NavigationLink(value: SearchDetailRoute.license) {
          IconLabel(icon: "file", text: "ライセンスを見る")
        }
        .buttonStyle(MonoButtonStyle())
        .accessibilityIdentifier("license-link")
        Text(
          "バージョン \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—")"
        )
        .font(.footnote)
      }
      .padding(20).frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(.surface)
    .navigationTitle("Public Phonebookについて").navigationBarTitleDisplayMode(.inline)
    .accessibilityIdentifier("about-content")
  }

  private func section(_ title: String) -> some View {
    Text(title).font(.title2.bold()).padding(.top, 12).accessibilityAddTraits(.isHeader)
  }
}

/// Lists who publishes each category of the saved data and under which license.
struct SourcesScreen: View {
  let categories: [CategoryInfo]

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        Text("施設の種類ごとに、データを公開している組織と、使うときの決まりです。")
          .padding(.bottom, 12)
        ForEach(categories) { category in
          VStack(alignment: .leading, spacing: 4) {
            Text(category.label).bold()
            Text("\(category.publisher)・\(category.license)").font(.callout)
          }
          .padding(.vertical, 12)
          .accessibilityElement(children: .combine)
          Rectangle().fill(.ink).frame(height: 1)
        }
      }.padding(20)
    }
    .background(.surface)
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
    .foregroundStyle(.ink).background(.surface)
    .navigationTitle("ライセンス").navigationBarTitleDisplayMode(.inline)
    .accessibilityIdentifier("license-content")
  }
}
