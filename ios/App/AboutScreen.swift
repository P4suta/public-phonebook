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
        Text("学校や役所、病院などの電話番号を、名前でさがせるアプリです。")
        Text("国や自治体などが公開しているデータをもとにしています。")
        Text("国や自治体の公式アプリではありません。")

        section("使い方")
        Text("検索欄に施設の名前か、電話番号を入れます。")
        Text("電話の相手が分かるようにするには、「設定」から\(AppIdentity.displayName)を許可します。")
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
        NavigationLink {
          SourcesScreen(categories: model.categories)
        } label: {
          IconLabel(icon: "info", text: "データのもとを見る")
        }
        .buttonStyle(MonoButtonStyle())
        .accessibilityIdentifier("sources-link")

        section("プライバシー")
        Text("検索した言葉は、このiPhoneの中だけで使います。サービスには送りません。")
        Text("自分の連絡先や通話の履歴を読んだり、変えたり、サービスに送ったりすることはありません。")
        Text("データを受け取るときは、IPアドレスなどの接続の情報を使います。配信にはCloudflareを使っています。")
        Text("iPhoneの設定で\(AppIdentity.displayName)を許可すると、受け取った公開データをiOSに渡します。")
        Text("アカウントの登録、広告、行動の追跡はありません。受け取ったデータは、アプリを削除すると消えます。")
        Text("「地図で見る」からAppleのマップを開くときは、場所をさがすために施設の名前と住所をAppleに送ります。")
        Text("施設のページなど、ほかのサイトやアプリを開いたときは、そのサイトやアプリの決まりが使われます。")

        section("開発者に声を伝える")
        Text("感想や使い方の質問、不具合、情報のまちがいは、メールで送ってください。")
        Text("電話番号や住所など、いらない個人の情報は書かないでください。")
        Button {
          if let url = URL(string: "mailto:support@dial.page") { openURL(url) }
        } label: {
          IconLabel(icon: "messages-square", text: "開発者にメールを送る")
        }
        .buttonStyle(MonoButtonStyle())
        .accessibilityHint("メールアプリを開きます。")

        NavigationLink {
          LicenseScreen()
        } label: {
          IconLabel(icon: "file", text: "ライセンスを見る")
        }
        .buttonStyle(MonoButtonStyle())
        .accessibilityIdentifier("license-link")
        Text(
          "バージョン \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—")"
        )
        .font(.footnote)
      }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
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
private struct SourcesScreen: View {
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
