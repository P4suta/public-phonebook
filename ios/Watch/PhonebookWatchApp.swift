import PhonebookCore
import SwiftUI

@main
struct PhonebookWatchApp: App {
  @State private var model = WatchSearchModel()

  var body: some Scene {
    WindowGroup {
      NavigationStack {
        List {
          TextField(
            "施設の名前でさがす", text: $model.query,
            prompt: Text("施設の名前でさがす").foregroundStyle(.white)
          )
          .submitLabel(.search)
          .onSubmit { model.search() }
          .accessibilityLabel("施設の名前でさがす")
          .accessibilityIdentifier("watch-search")
          if model.loading {
            ProgressView("さがしています")
          }
          if let message = model.message {
            Text(message).accessibilityIdentifier("watch-search-message")
            Button {
              model.search()
            } label: {
              Label("もう一度さがす", systemImage: "arrow.clockwise")
            }
            .disabled(!model.canSearch)
          }
          if let reply = model.reply {
            Section("「\(model.answeredQuery)」の結果") {
              if reply.total == 0 {
                Text("あてはまる施設は0件です")
              } else {
                Text("\(reply.total)件中、\(reply.results.count)件を表示します。")
                ForEach(reply.results) { facility in
                  NavigationLink(value: facility) {
                    Label {
                      VStack(alignment: .leading) {
                        Text(facility.name)
                        if !facility.region.isEmpty { Text(facility.region) }
                      }
                    } icon: {
                      Image(systemName: "building.2")
                    }
                  }
                  .accessibilityIdentifier("watch-facility")
                }
              }
            }
          } else if !model.loading, model.message == nil {
            Text("iPhoneに保存した公開データから、施設の電話番号をさがします。")
            Text("iPhoneとつながると使えます。")
          }
          NavigationLink {
            WatchAboutScreen()
          } label: {
            Label("Public Phonebookについて", systemImage: "info.circle")
          }
        }
        .navigationTitle("電話番号をさがす")
        .navigationDestination(for: WatchFacility.self) { facility in
          WatchFacilityScreen(facility: facility)
        }
      }
      .tint(.white)
    }
  }
}

private struct WatchAboutScreen: View {
  var body: some View {
    List {
      Text("無料で使えます。プログラムも公開しています。")
      Text("検索する言葉はiPhoneに送ります。サービスには送りません。")
      Text("使い方の記録や診断の情報は集めません。")
      WatchExternalLink(
        title: "プログラムを見る", destination: "https://github.com/P4suta/public-phonebook",
        message: "GitHubでPublic Phonebookのプログラムを開きます。")
    }
    .navigationTitle("Public Phonebookについて")
  }
}

private struct WatchFacilityScreen: View {
  let facility: WatchFacility

  private var licenseName: String {
    switch facility.license {
    case "Public Domain": "パブリックドメイン"
    case "CC0-1.0": "Creative Commons CC0 1.0 Universal"
    case "CC-BY-4.0": "Creative Commons Attribution 4.0 International"
    default: facility.license
    }
  }

  var body: some View {
    List {
      Section {
        Text(facility.name).font(.headline)
        if !facility.region.isEmpty { Text(facility.region) }
        ForEach(facility.numbers, id: \.self) { number in
          Text(SearchInput.nationalDisplay("", e164: number))
            .font(.title3.monospacedDigit())
            .accessibilityIdentifier("watch-number")
        }
      }
      Section("電話番号のもとの情報") {
        Text(facility.publisher)
        Text(licenseName)
        if let source = facility.sourceURL {
          WatchExternalLink(
            title: "もとの情報を見る", destination: source,
            message: "データを公開しているページを開きます。"
          )
          .accessibilityIdentifier("watch-source")
        }
        if let license = facility.licenseURL {
          WatchExternalLink(
            title: "使うときの決まりを見る", destination: license,
            message: "データを使うときの決まりのページを開きます。"
          )
          .accessibilityIdentifier("watch-license")
        }
      }
    }
    .navigationTitle("施設の情報")
  }
}

private struct WatchExternalLink: View {
  let title: String
  let destination: String
  let message: String
  @State private var confirms = false

  var body: some View {
    if let url = URL(string: destination) {
      Button {
        confirms = true
      } label: {
        Label(title, systemImage: "arrow.up.forward.square")
      }
      .confirmationDialog("ほかのサイトを開きます", isPresented: $confirms) {
        Link(destination: url) { Label("開く", systemImage: "arrow.up.forward.square") }
      } message: {
        Text(message)
      }
    }
  }
}
