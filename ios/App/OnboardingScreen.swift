import PhonebookKit
import SwiftUI

/// The first-run steps while the app's data downloads on its own: introduce the app, then turn on caller names.
struct OnboardingScreen: View {
  @Bindable var integration: IntegrationModel
  let finish: () -> Void
  @State private var step = Step.welcome
  @AccessibilityFocusState private var headingFocused: Bool

  private enum Step: Int, CaseIterable {
    case welcome, caller, ready
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          if step != .welcome {
            Text("\(step.rawValue) / 2").font(.subheadline)
              .accessibilityLabel("2つのうち\(step.rawValue)つめ")
          }
          content
        }
        .padding(20).frame(maxWidth: .infinity, alignment: .leading)
      }
      .background(.white)
      .safeAreaInset(edge: .bottom, spacing: 0) { footer }
      .toolbar {
        if step != .welcome {
          ToolbarItem(placement: .topBarLeading) {
            Button {
              move(to: Step(rawValue: step.rawValue - 1) ?? .welcome)
            } label: {
              DesignIcon(name: "chevron-left").frame(minWidth: 44, minHeight: 44)
            }
            .accessibilityLabel("前にもどる")
          }
        }
      }
      .navigationBarTitleDisplayMode(.inline)
      .toolbarBackground(.white, for: .navigationBar)
    }
    .tint(.black)
  }

  @ViewBuilder private var content: some View {
    switch step {
    case .welcome:
      heading(AppIdentity.displayName)
      Text("学校や役所、病院などの電話番号を、iPhoneの中でさがせるアプリです。")
      Feature(
        icon: "phone", title: "着信に施設の名前が出ます",
        detail: "役所や病院などからの電話に、着信画面で名前を出せます。")
      Feature(
        icon: "search", title: "通信なしで、すぐにさがせます",
        detail: "アプリで使うデータを先に受け取っておくので、電波がなくてもさがせます。")
    case .caller:
      heading("着信に施設の名前を出す")
      Text("役所や病院などから電話がかかってきたとき、着信画面に施設の名前を出します。")
      if integration.callerEnabled {
        Done(text: "オンになっています。")
      } else {
        Text("「iPhoneの設定を開く」を押し、\(AppIdentity.displayName)をオンにしてから、このアプリにもどってください。")
      }
    case .ready:
      heading(
        integration.manifest != nil
          ? "準備ができました"
          : integration.progress == nil ? "データを受け取れませんでした" : "データを受け取っています")
      Text("施設や窓口の名前か電話番号を入れると、さがせます。")
      Text("着信に名前を出す設定は、あとから「設定」で変えられます。")
    }
    if let problem = integration.problem {
      Text(problem).fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("sync-error")
    }
  }

  private var footer: some View {
    VStack(alignment: .leading, spacing: 12) {
      if integration.progress != nil {
        SaveProgress(percent: integration.percent, remaining: integration.remainingSeconds)
      }
      switch step {
      case .welcome:
        Button {
          move(to: .caller)
        } label: {
          Text("はじめる")
        }
        .buttonStyle(MonoButtonStyle(prominent: true))
        .accessibilityIdentifier("onboarding-start")
      case .caller:
        if integration.callerEnabled {
          next(.ready)
        } else {
          Button {
            integration.openCallerSettings()
          } label: {
            IconLabel(icon: "settings", text: "iPhoneの設定を開く")
          }
          .buttonStyle(MonoButtonStyle(prominent: true))
          .accessibilityIdentifier("onboarding-caller")
          later(.ready)
        }
      case .ready:
        Button(action: finish) {
          IconLabel(icon: "search", text: "さがしはじめる")
        }
        .buttonStyle(MonoButtonStyle(prominent: true))
        .disabled(integration.manifest == nil)
        .accessibilityIdentifier("onboarding-finish")
      }
    }
    .padding(20)
    .background(.white)
    .overlay(alignment: .top) { Rectangle().fill(.black).frame(height: 1) }
  }

  private func heading(_ text: String) -> some View {
    Text(text).font(.largeTitle.bold()).fixedSize(horizontal: false, vertical: true)
      .accessibilityAddTraits(.isHeader)
      .accessibilityFocused($headingFocused)
  }

  private func next(_ target: Step) -> some View {
    Button {
      move(to: target)
    } label: {
      Text("次へ")
    }
    .buttonStyle(MonoButtonStyle(prominent: true))
    .accessibilityIdentifier("onboarding-next")
  }

  private func later(_ target: Step) -> some View {
    Button {
      move(to: target)
    } label: {
      Text("あとで設定する")
    }
    .buttonStyle(MonoButtonStyle())
    .accessibilityIdentifier("onboarding-later")
  }

  private func move(to target: Step) {
    step = target
    headingFocused = true
  }
}

private struct Feature: View {
  let icon: String
  let title: String
  let detail: String

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      DesignIcon(name: icon, size: 28)
      VStack(alignment: .leading, spacing: 4) {
        Text(title).font(.headline)
        Text(detail).font(.callout)
      }
    }
    .padding(.vertical, 4)
    .accessibilityElement(children: .combine)
  }
}

private struct Done: View {
  let text: String

  var body: some View {
    HStack(spacing: 8) {
      DesignIcon(name: "check")
      Text(text).bold()
    }
    .accessibilityElement(children: .combine)
  }
}

struct SaveProgress: View {
  let percent: Int
  /// Seconds left, or nil while the estimate lacks data.
  let remaining: Int?

  private var remainingText: String {
    remaining.map { "残り約\(IntegrationModel.duration($0))" } ?? "残りの時間を計っています"
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text("アプリで使うデータを受け取っています")
        Spacer()
        Text("\(percent)%").monospacedDigit()
      }
      .font(.callout)
      ProgressView(value: Double(percent), total: 100).tint(.black)
      Text(remainingText).font(.footnote).monospacedDigit()
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("アプリで使うデータを受け取っています")
    .accessibilityValue("\(percent)パーセント、\(remainingText)")
    .accessibilityIdentifier("sync-progress")
  }
}
