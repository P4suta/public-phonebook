import PhonebookCore
import PhonebookKit
import SwiftUI

/// One icon from the design masters, which scales with the text size from its size at the default text size.
struct DesignIcon: View {
  let name: String
  @ScaledMetric private var size: CGFloat

  init(name: String, size: CGFloat = 22) {
    self.name = name
    _size = ScaledMetric(wrappedValue: size)
  }

  var body: some View {
    Image(name).renderingMode(.template).resizable()
      .frame(width: size, height: size).accessibilityHidden(true)
  }
}

extension Phone {
  var nationalDisplay: String {
    SearchInput.nationalDisplay(display, e164: e164.rawValue)
  }
}

struct CallButton: View {
  let phone: Phone
  var iconOnly = false
  var showNumber = false
  @Environment(\.openURL) private var openURL

  var body: some View {
    Button {
      if let url = URL(string: "tel:" + phone.e164.rawValue) { openURL(url) }
    } label: {
      if iconOnly {
        Image(systemName: "phone").frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
      } else {
        Label(showNumber ? phone.nationalDisplay : "電話をかける", systemImage: "phone")
      }
    }
    .buttonStyle(.borderless)
    .accessibilityLabel(showNumber ? phone.nationalDisplay : "\(phone.nationalDisplay)に電話をかける")
  }
}

struct PhoneActions: View {
  let phone: Phone

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(phone.nationalDisplay).font(.title2).monospacedDigit()
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
        .accessibilityIdentifier("phone-number")
      CallButton(phone: phone)
    }
  }
}

enum ExternalDestination {
  case facility, publication, license, source, sourceCode, other

  var description: String {
    switch self {
    case .facility: "施設のホームページを開きます。"
    case .publication: "データを公開したページを開きます。"
    case .license: "データを使うときの決まりのページを開きます。"
    case .source: "電話番号のもとになった資料を開きます。"
    case .sourceCode: "GitHubでプログラムを開きます。"
    case .other: "ほかのサイトのページを開きます。"
    }
  }
}

struct ExternalPage {
  let url: URL
  let destination: ExternalDestination

  var hostLine: String { "行き先：\(url.host() ?? "")" }

  var message: String {
    "\(destination.description)\n\(hostLine)"
  }
}

struct ExternalLink<Label: View>: View {
  let url: URL
  let destination: ExternalDestination
  @Binding var page: ExternalPage?
  @ViewBuilder let label: () -> Label

  var body: some View {
    Button {
      page = ExternalPage(url: url, destination: destination)
    } label: {
      label()
    }
  }
}

struct ExternalPageConfirmation: ViewModifier {
  @Binding var page: ExternalPage?
  @Environment(\.openURL) private var openURL

  func body(content: Content) -> some View {
    let presented = Binding(get: { page != nil }, set: { if !$0 { page = nil } })
    content
      .alert("ページを開きます", isPresented: presented, presenting: page) { page in
        Button("開く") { openURL(page.url) }
        Button("キャンセル", role: .cancel) {}
      } message: { page in
        Text(page.message)
      }
  }
}

struct MapButton: View {
  let name: String
  let opening: Bool
  let confirm: () -> Void
  @ScaledMetric private var iconSize: CGFloat = 22

  var body: some View {
    Button(action: confirm) {
      HStack(spacing: 8) {
        if opening {
          ProgressView().frame(width: iconSize, height: iconSize).accessibilityHidden(true)
        } else {
          Image(systemName: "mappin.and.ellipse").accessibilityHidden(true)
        }
        Text(opening ? "場所をさがしています" : "地図で見る").font(.body)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .buttonStyle(.borderless)
    .disabled(opening)
    .accessibilityLabel(opening ? "\(name)の場所をさがしています" : "\(name)を地図で見る")
    .accessibilityIdentifier("map-button")
  }
}
