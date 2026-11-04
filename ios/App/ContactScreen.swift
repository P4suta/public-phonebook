import PhonebookKit
import SwiftUI

struct ContactScreen: View {
  let contact: Contact

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        HStack(spacing: 6) {
          DesignIcon(name: IconCatalog.categories[contact.categoryKey] ?? "file", size: 16)
          Text(contact.category)
        }.font(.subheadline)
        Text(contact.name).font(.largeTitle.bold()).textSelection(.enabled)
          .accessibilityAddTraits(.isHeader)
        ForEach(contact.phones, id: \.e164) { PhoneActions(phone: $0, large: true) }
        VStack(alignment: .leading, spacing: 12) {
          VStack(alignment: .leading, spacing: 6) {
            Text("住所").font(.headline)
            Text(contact.address.isEmpty ? contact.region : contact.address).font(.callout)
              .textSelection(.enabled)
              .accessibilityIdentifier("contact-address")
          }
          if !contact.address.isEmpty {
            MapButton(name: contact.name, address: contact.address)
          }
        }
        if let raw = contact.website, let url = WebAddress.url(raw) {
          ExternalLink(url: url, destination: .facility) {
            IconLabel(icon: "external", text: "施設のホームページを開く")
          }.buttonStyle(MonoButtonStyle())
        }
        Rectangle().fill(.ink).frame(height: 1)
        Text("電話番号のもとの情報").font(.title2.bold()).accessibilityAddTraits(.isHeader)
        Text("\(contact.provenance.publisher)が公開したデータです。")
        if let date = DateText.japanese(contact.provenance.dataAsOf) {
          Text("データの日付：\(date)").accessibilityIdentifier("source-data-date")
        }
        NavigationLink {
          SourceScreen(contact: contact)
        } label: {
          IconLabel(icon: "info", text: "電話番号のもとの情報を見る")
        }
        .buttonStyle(MonoButtonStyle())
        .accessibilityIdentifier("source-link")
      }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(.surface).navigationTitle("施設の情報").navigationBarTitleDisplayMode(.inline)
  }
}

enum DateText {
  static func japanese(_ value: String) -> String? {
    let parts = value.prefix(10).split(separator: "-").compactMap { Int($0) }
    guard parts.count == 3, value.prefix(10).count == 10 else { return nil }
    return "\(parts[0])年\(parts[1])月\(parts[2])日"
  }
}

private struct SourceScreen: View {
  let contact: Contact

  var body: some View {
    let provenance = contact.provenance
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        Text("電話番号のもとの情報").font(.title.bold()).accessibilityAddTraits(.isHeader)
        Text(contact.name).font(.headline)
        ForEach(contact.phones, id: \.e164) { Text($0.display).font(.title.bold()) }
        Text("\(provenance.publisher)が公開したデータです。")
        let publications = provenance.publications.filter { $0 != provenance.sourceURL }
        ForEach(Array(publications.enumerated()), id: \.offset) { index, raw in
          if let url = WebAddress.url(raw) {
            ExternalLink(url: url, destination: .publication) {
              IconLabel(
                icon: "external",
                text: publications.count == 1
                  ? "データを公開したページを見る" : "データを公開したページを見る（\(index + 1)）")
            }.buttonStyle(MonoButtonStyle())
          }
        }
        if let date = DateText.japanese(provenance.dataAsOf) {
          Text("データの日付：\(date)").accessibilityIdentifier("source-data-date")
        }
        if let date = DateText.japanese(provenance.retrievedAt) { Text("データを集めた日：\(date)") }
        Text(
          "使うときの決まり：\(provenance.license == "Public Domain" ? "パブリックドメイン" : provenance.license)"
        )
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("source-license")
        if let url = WebAddress.url(provenance.licenseURL) {
          ExternalLink(url: url, destination: .license) {
            IconLabel(icon: "external", text: "データを使うときの決まりを見る")
          }.buttonStyle(MonoButtonStyle())
        }
        if let raw = provenance.sourceURL, let url = WebAddress.url(raw) {
          ExternalLink(url: url, destination: .source) {
            IconLabel(icon: "external", text: "もとの資料を開く")
          }.buttonStyle(MonoButtonStyle())
        }
      }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(.surface).navigationTitle("電話番号のもとの情報").navigationBarTitleDisplayMode(.inline)
  }
}
