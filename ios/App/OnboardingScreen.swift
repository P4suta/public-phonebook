import PhonebookKit
import SwiftUI

/// The first-run steps: introduce the app and start the download, turn on caller names, then wait for the data.
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
            Text("\(step.rawValue) / 2").font(.subheadline).fixedSize(
              horizontal: false, vertical: true
            )
            .accessibilityLabel("2つのうち\(step.rawValue)つめ")
          }
          content
        }
        .padding(20).frame(maxWidth: .infinity, alignment: .leading)
      }
      .background(.surface)
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
      .toolbarBackground(.surface, for: .navigationBar)
    }
    .tint(.ink)
  }

  @ViewBuilder private var content: some View {
    switch step {
    case .welcome:
      heading(AppIdentity.displayName)
      Text("学校や役所、病院などの電話番号を、iPhoneの中でさがせるアプリです。")
      Feature(
        icon: "phone", title: "電話の相手が分かります",
        detail: "病院や役所などから電話がかかってきたとき、iPhoneの画面に施設の名前が出ます。")
      Feature(
        icon: "search", title: "通信なしで、すぐにさがせます",
        detail: "アプリで使うデータを先に受け取っておくので、電波がなくてもさがせます。")
    case .caller:
      heading("電話の相手が分かるようにする")
      Text("病院や役所などから電話がかかってきたとき、iPhoneの画面に施設の名前が出ます。")
      if integration.callerEnabled {
        Done(text: "許可しています。")
      } else {
        Text("iPhoneの設定で、\(AppIdentity.displayName)を許可してください。")
        Text("許可したら、このアプリにもどってください。")
      }
    case .ready:
      if integration.ready {
        heading("準備ができました")
        Text("施設の名前か電話番号を入れると、さがせます。")
        if integration.bundledOnly, let manifest = integration.manifest {
          Text("アプリに入っている、\(manifest.dataDate.formatted(date: .long, time: .omitted))のデータを使います。")
            .accessibilityIdentifier("bundled-date")
          Text("通信できるようになると、新しいデータを自動で受け取ります。")
        }
        Text("電話の相手が分かるようにする設定は、あとから「設定」で変えられます。")
      } else if let stopped = integration.stopped {
        heading("データの受け取りが止まりました")
        Text(stopped).fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("sync-error")
      } else {
        heading(FirstDownloadProgress.heading(preparing: integration.preparing))
        if let wait = integration.wait {
          FirstDownloadProgress(
            wait: wait, fraction: integration.fraction, preparing: integration.preparing,
            showsHeading: false)
        }
      }
    }
    if step != .ready, let problem = integration.problem {
      Text(problem).fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("sync-error")
    }
  }

  private var footer: some View {
    VStack(alignment: .leading, spacing: 12) {
      switch step {
      case .welcome:
        if let notice = integration.notice {
          DataSizeNotice(notice: notice, costlyPath: integration.costlyPath)
        }
        Button {
          integration.startFirstDownload()
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
        .disabled(!integration.ready)
        .accessibilityIdentifier("onboarding-finish")
      }
    }
    .padding(20)
    .background(.surface)
    .overlay(alignment: .top) { Rectangle().fill(.ink).frame(height: 1) }
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
