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
  var large = false
  @Environment(\.openURL) private var openURL

  private var display: String {
    SearchInput.nationalDisplay(phone.display, e164: phone.e164.rawValue)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(display).font(large ? .largeTitle.bold() : .title.bold()).monospacedDigit()
        .textSelection(.enabled)
        .accessibilityIdentifier("phone-number")
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
  case facility, publication, license, source, other

  var description: String {
    switch self {
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

/// Opens the facility in Apple Maps after a confirmation, beneath the address that stays plain selectable text.
struct MapButton: View {
  let name: String
  let address: String
  @State private var confirming = false
  @State private var opening = false
  @State private var missing = false

  var body: some View {
    Button {
      confirming = true
    } label: {
      IconLabel(icon: "location", text: "地図で見る")
    }
    .buttonStyle(MonoButtonStyle())
    .disabled(opening)
    .accessibilityLabel("\(name)を地図で見る")
    .accessibilityIdentifier("map-button")
    .alert("マップで開きます", isPresented: $confirming) {
      Button("開く") {
        opening = true
        Task {
          missing = !(await MapDestination.open(name: name, address: address))
          opening = false
        }
      }
      Button("やめる", role: .cancel) {}
    } message: {
      Text("この施設の場所を、Appleのマップで表示します。\n場所を探すために、施設の名前と住所をAppleに送ります。")
    }
    .alert("場所を見つけられませんでした", isPresented: $missing) {
      Button("閉じる", role: .cancel) {}
    } message: {
      Text("インターネットにつながっているか確かめて、もう一度試してください。")
    }
  }
}
