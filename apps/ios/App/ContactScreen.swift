import PhonebookKit
import SwiftUI

struct ContactScreen: View {
  let contact: Contact
  @State private var page: ExternalPage?
  @State private var confirmsMap = false
  @State private var openingMap = false
  @State private var mapMissing = false
  private let mapError = "場所を見つけられませんでした"
  private let mapRetry = "インターネットにつながっているかたしかめて、もう一度試してください。"

  var body: some View {
    List {
      Section {
        Text(contact.name).font(.title.bold()).textSelection(.enabled)
          .accessibilityAddTraits(.isHeader)
      } header: {
        Label {
          Text(contact.category)
        } icon: {
          DesignIcon(name: IconCatalog.categories[contact.categoryKey] ?? "file", size: 16)
        }
        .foregroundStyle(TintShapeStyle())
      }
      Section {
        ForEach(contact.phones, id: \.e164) { PhoneActions(phone: $0) }
      } header: {
        Text("電話番号").foregroundStyle(TintShapeStyle())
      }
      Section {
        Text(contact.address.isEmpty ? contact.region : contact.address)
          .textSelection(.enabled)
          .accessibilityIdentifier("contact-address")
        if !contact.address.isEmpty {
          MapButton(name: contact.name, opening: openingMap) {
            mapMissing = false
            confirmsMap = true
          }
          if mapMissing {
            VStack(alignment: .leading) {
              Text(mapError).font(.headline)
              Text(mapRetry)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("map-error")
          }
        }
      } header: {
        Text("住所").foregroundStyle(TintShapeStyle())
      }
      if let raw = contact.website, let url = WebAddress.url(raw) {
        ExternalLink(url: url, destination: .facility, page: $page) {
          Label("施設のホームページを開く", systemImage: "arrow.up.right.square")
        }
      }
      Section {
        Text("\(contact.provenance.publisher)が公開したデータです。")
        if let date = DateText.japanese(contact.provenance.dataAsOf) {
          Text("データの日付：\(date)").font(.body)
            .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier(
              "source-data-date")
        }
        NavigationLink(value: SearchRoute.source(contact)) {
          Label("もとの情報を見る", systemImage: "info.circle").font(.body)
            .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityIdentifier("source-link")
      } header: {
        Text("電話番号のもとの情報").foregroundStyle(TintShapeStyle())
      }
    }
    .accessibilityIdentifier("contact-content")
    .accessibilityHidden(confirmsMap || page != nil)
    .modifier(ExternalPageConfirmation(page: $page))
    .alert("地図を開きます", isPresented: $confirmsMap) {
      Button("開く") {
        openingMap = true
        Task {
          mapMissing = !(await MapDestination.open(name: contact.name, address: contact.address))
          openingMap = false
          if mapMissing { AccessibilityAnnouncement.post(mapError + "。" + mapRetry) }
        }
      }
      Button("キャンセル", role: .cancel) {}
    } message: {
      Text("施設の名前と住所をAppleのマップに送ります。")
    }
    .navigationTitle("施設の情報").navigationBarTitleDisplayMode(.inline)
  }
}

enum DateText {
  static func japanese(_ value: String) -> String? {
    let parts = value.prefix(10).split(separator: "-").compactMap { Int($0) }
    guard parts.count == 3, value.prefix(10).count == 10 else { return nil }
    return "\(parts[0])年\(parts[1])月\(parts[2])日"
  }
}

struct SourceScreen: View {
  let contact: Contact
  @State private var page: ExternalPage?

  private var licenseName: String {
    switch contact.provenance.license {
    case "Public Domain": "パブリックドメイン"
    case "CC0-1.0": "Creative Commons CC0 1.0 Universal"
    case "CC-BY-4.0": "Creative Commons Attribution 4.0 International"
    default: contact.provenance.license
    }
  }

  var body: some View {
    let provenance = contact.provenance
    List {
      Section {
        ForEach(contact.phones, id: \.e164) { phone in
          Text(phone.nationalDisplay).monospacedDigit().textSelection(.enabled)
        }
      } header: {
        Text(contact.name).foregroundStyle(TintShapeStyle())
      }
      Section {
        Text("\(provenance.publisher)が公開したデータです。")
        let publications = provenance.publications.filter { $0 != provenance.sourceURL }
        ForEach(Array(publications.enumerated()), id: \.offset) { index, raw in
          if let url = WebAddress.url(raw) {
            ExternalLink(url: url, destination: .publication, page: $page) {
              Label(
                publications.count == 1 ? "データのページを開く" : "データのページを開く（\(index + 1)）",
                systemImage: "arrow.up.right.square")
            }
          }
        }
        if let date = DateText.japanese(provenance.dataAsOf) {
          Text("データの日付：\(date)").font(.body)
            .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier(
              "source-data-date")
        }
        if let date = DateText.japanese(provenance.retrievedAt) { Text("データを集めた日：\(date)") }
        Text("使うときの決まり：\(licenseName)")
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("source-license")
        if let url = WebAddress.url(provenance.licenseURL) {
          ExternalLink(url: url, destination: .license, page: $page) {
            Label("使うときの決まりを見る", systemImage: "arrow.up.right.square")
          }
        }
        if let raw = provenance.sourceURL, let url = WebAddress.url(raw) {
          ExternalLink(url: url, destination: .source, page: $page) {
            Label("もとの資料を開く", systemImage: "arrow.up.right.square")
          }
        }
      } header: {
        Text("公開元").foregroundStyle(TintShapeStyle())
      }
    }
    .accessibilityIdentifier("source-content")
    .accessibilityHidden(page != nil)
    .modifier(ExternalPageConfirmation(page: $page))
    .navigationTitle("電話番号のもとの情報").navigationBarTitleDisplayMode(.inline)
  }
}
