import PhonebookCore
import PhonebookKit
import SwiftUI

struct MonoButtonStyle: ButtonStyle {
  var prominent = false

  func makeBody(configuration: Configuration) -> some View {
    MonoButton(configuration: configuration, prominent: prominent)
  }
}

/// Draws an unavailable button as a dashed outline so that it never looks pressable.
private struct MonoButton: View {
  let configuration: ButtonStyleConfiguration
  let prominent: Bool
  @Environment(\.isEnabled) private var enabled

  var body: some View {
    let filled = enabled && prominent != configuration.isPressed
    configuration.label
      .font(.body.weight(.semibold))
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, minHeight: 44)
      .padding(.horizontal, 12)
      .foregroundStyle(filled ? .white : .black)
      .background(filled ? Color.black : Color.white)
      .overlay {
        Rectangle().stroke(
          .black, style: StrokeStyle(lineWidth: 2, dash: enabled ? [] : [6, 4]))
      }
      .contentShape(Rectangle())
  }
}

struct DesignIcon: View {
  let name: String
  var size: CGFloat = 22

  var body: some View {
    Image(name).renderingMode(.template).resizable()
      .frame(width: size, height: size).accessibilityHidden(true)
  }
}

struct IconLabel: View {
  let icon: String
  let text: String

  var body: some View {
    HStack(spacing: 8) {
      DesignIcon(name: icon)
      Text(text)
    }
  }
}

struct PhoneActions: View {
  let phone: Phone
  let name: String
  var large = false
  @Environment(\.openURL) private var openURL
  @State private var copied: Bool?

  private var display: String {
    SearchInput.nationalDisplay(phone.display, e164: phone.e164.rawValue)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Button {
        UIPasteboard.general.string = display
        copied = UIPasteboard.general.string == display
      } label: {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(display).font(large ? .largeTitle.bold() : .title.bold()).monospacedDigit()
          Text("コピーする").font(.caption).underline()
        }
      }
      .buttonStyle(.plain)
      .accessibilityLabel("\(display) コピーする（\(name)の電話番号）")
      .accessibilityIdentifier("phone-copy")
      if let copied {
        Text(copied ? "電話番号をコピーしました。" : "コピーできませんでした。文字をえらんでコピーしてください。")
          .font(.footnote).accessibilityIdentifier("copy-feedback")
      }
      Button {
        if let url = URL(string: "tel:" + phone.e164.rawValue) { openURL(url) }
      } label: {
        IconLabel(icon: "phone", text: "電話をかける")
      }
      .buttonStyle(MonoButtonStyle(prominent: true))
      .accessibilityLabel("\(display)に電話をかける")
    }
  }
}

enum ExternalDestination {
  case map, facility, publication, license, source, other

  var description: String {
    switch self {
    case .map: "この住所を、Googleマップで表示します。"
    case .facility: "この施設のページを開きます。"
    case .publication: "このデータを公開しているページを開きます。"
    case .license: "データを使うときの決まりのページを開きます。"
    case .source: "電話番号のもとになった資料を開きます。"
    case .other: "ほかのサイトのページを開きます。"
    }
  }
}

struct ExternalLink<Label: View>: View {
  let url: URL
  let destination: ExternalDestination
  @ViewBuilder let label: () -> Label
  @Environment(\.openURL) private var openURL
  @State private var confirming = false

  var body: some View {
    Button {
      confirming = true
    } label: {
      label()
    }
    .alert("ほかのサイトを開きます", isPresented: $confirming) {
      Button("開く") { openURL(url) }
      Button("やめる", role: .cancel) {}
    } message: {
      Text("\(destination.description)\n行き先：\(url.host() ?? "")\nブラウザーで開きます。")
    }
  }
}

struct AddressLink: View {
  let address: String

  var body: some View {
    if let url = Self.mapURL(address) {
      ExternalLink(url: url, destination: .map) {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          DesignIcon(name: "location", size: 16)
          Text(address).font(.callout).underline().multilineTextAlignment(.leading)
          DesignIcon(name: "external", size: 14)
        }
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("address-link")
    } else {
      Text(address).font(.callout)
    }
  }

  static func mapURL(_ address: String) -> URL? {
    var components = URLComponents(string: "https://www.google.com/maps/search/")
    components?.queryItems = [
      URLQueryItem(name: "api", value: "1"), URLQueryItem(name: "query", value: address),
    ]
    return components?.url
  }
}
