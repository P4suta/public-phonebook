import PhonebookKit
import SwiftUI

/// The first-run steps: introduce the app and start the download, turn on caller names, then wait for the data.
struct OnboardingScreen: View {
  @Bindable var integration: IntegrationModel
  let finish: () -> Void
  @State private var path: [Step] = []

  private enum Step: Int, Hashable {
    case welcome, caller, ready
  }

  var body: some View {
    NavigationStack(path: $path) {
      screen(.welcome)
        .navigationDestination(for: Step.self) { screen($0) }
    }
    .tint(.ink)
  }

  private func screen(_ step: Step) -> some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        if step != .welcome {
          Text("\(step.rawValue) / 2").font(.subheadline).fixedSize(
            horizontal: false, vertical: true
          )
          .accessibilityLabel("2つのうち\(step.rawValue)つめ")
        }
        content(step)
      }
      .padding(20).frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(.surface)
    .safeAreaInset(edge: .bottom, spacing: 0) { footer(step) }
    .navigationBarTitleDisplayMode(.inline)
    .toolbarBackground(.surface, for: .navigationBar)
  }

  @ViewBuilder private func content(_ step: Step) -> some View {
    switch step {
    case .welcome:
      heading(AppIdentity.displayName)
      Text("役所や学校、病院などの電話番号をさがせます。")
      Feature(
        icon: "phone", title: "電話の相手が分かります",
        detail: "アプリにある番号からiPhoneに電話がかかってきたとき、施設の名前が出ます。")
      Feature(
        icon: "search", title: "通信なしでさがせます",
        detail: "初めの準備が終わると、通信なしでさがせます。")
    case .caller:
      heading("電話の相手が分かるようにする")
      Text("アプリにある番号から電話がかかってきたとき、施設の名前が出ます。")
      if integration.callerEnabled {
        Done(text: "許可しています。")
      } else {
        Text("設定で「\(AppIdentity.displayName)」を許可してください。")
        Text("許可したら、アプリにもどってください。")
      }
    case .ready:
      if integration.ready {
        heading("準備ができました")
        Text("施設の名前を入れてください。")
        if integration.bundledOnly, let manifest = integration.manifest {
          Text("\(manifest.dataDate.formatted(date: .long, time: .omitted))のデータを使います。")
            .accessibilityIdentifier("bundled-date")
          Text("通信がもどると、新しいデータを自動で確認します。")
        }
        Text("電話の相手の表示は、あとから「設定」で変えられます。")
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

  private func footer(_ step: Step) -> some View {
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
            IconLabel(icon: "settings", text: "設定を開く")
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
    path.append(target)
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
