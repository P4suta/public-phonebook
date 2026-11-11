import PhonebookCore
import PhonebookKit
import SwiftUI

struct MonoButtonStyle: ButtonStyle {
  var prominent = false
  var iconOnly = false

  func makeBody(configuration: Configuration) -> some View {
    MonoButton(configuration: configuration, prominent: prominent, iconOnly: iconOnly)
  }
}

/// Draws an unavailable button as a dashed outline so that it never looks pressable.
private struct MonoButton: View {
  let configuration: ButtonStyleConfiguration
  let prominent: Bool
  let iconOnly: Bool
  @Environment(\.isEnabled) private var enabled

  var body: some View {
    let filled = enabled && prominent != configuration.isPressed
    configuration.label
      .font(.body.weight(.semibold))
      .fixedSize(horizontal: false, vertical: true)
      .frame(
        maxWidth: iconOnly ? nil : .infinity, minHeight: 44,
        maxHeight: iconOnly ? .infinity : nil
      )
      .padding(.horizontal, iconOnly ? 0 : 12)
      .foregroundStyle(filled ? .surface : .ink)
      .background(filled ? .ink : .surface)
      .overlay {
        Rectangle().strokeBorder(
          .ink, style: StrokeStyle(lineWidth: 2, dash: enabled ? [] : [6, 4]))
      }
      .contentShape(Rectangle())
      .fixedSize(horizontal: false, vertical: !iconOnly)
  }
}

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
    VStack(alignment: .leading, spacing: 16) {
      Text(display).font(large ? .largeTitle.bold() : .title.bold()).monospacedDigit()
        .foregroundStyle(.ink)
        .background(.surface)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.vertical, 8)
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
    .alert("ページを開きます", isPresented: $confirming) {
      Button("開く") { openURL(url) }
      Button("キャンセル", role: .cancel) {}
    } message: {
      Text("\(destination.description)\n行き先：\(url.host() ?? "")")
    }
  }
}

/// Opens the facility in Apple Maps after a confirmation, beneath the address that stays plain selectable text.
/// While the address lookup runs, an activity indicator and a busy label replace the pin and the label, so a tap never looks ignored.
/// See https://developer.apple.com/design/human-interface-guidelines/feedback and https://developer.apple.com/design/human-interface-guidelines/buttons.
struct MapButton: View {
  let name: String
  let address: String
  @State private var confirming = false
  @State private var opening = false
  @State private var missing = false
  @ScaledMetric private var iconSize: CGFloat = 22

  var body: some View {
    Button {
      if !opening { confirming = true }
    } label: {
      HStack(spacing: 8) {
        if opening {
          ProgressView().tint(.ink).frame(width: iconSize, height: iconSize)
            .accessibilityHidden(true)
        } else {
          DesignIcon(name: "location")
        }
        Text(opening ? "場所をさがしています" : "地図で見る")
      }
    }
    .buttonStyle(MonoButtonStyle())
    .accessibilityLabel(opening ? "\(name)の場所をさがしています" : "\(name)を地図で見る")
    .accessibilityIdentifier("map-button")
    .alert("地図を開きます", isPresented: $confirming) {
      Button("開く") {
        opening = true
        Task {
          missing = !(await MapDestination.open(name: name, address: address))
          opening = false
        }
      }
      Button("キャンセル", role: .cancel) {}
    } message: {
      Text("施設の名前と住所をAppleのマップに送ります。")
    }
    .alert("場所を見つけられませんでした", isPresented: $missing) {
      Button("閉じる", role: .cancel) {}
    } message: {
      Text("インターネットにつながっているかたしかめて、もう一度試してください。")
    }
  }
}
