import PhonebookCore
import PhonebookKit
import SwiftUI

struct SettingsScreen: View {
  @Bindable var model: IntegrationModel

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        Text("電話の相手が分かるようにする").font(.headline).accessibilityAddTraits(.isHeader)
        Text(
          "iPhoneの設定で\(AppIdentity.displayName)を許可すると、病院や役所などから電話がかかってきたとき、iPhoneの画面に施設の名前が出ます。"
        )
        .font(.callout)
        Text("許可してから使えるようになるまで、20秒ほどかかります。")
          .font(.callout)
        CallerStatusLabel(status: model.callerStatus)
        Button {
          model.openCallerSettings()
        } label: {
          IconLabel(icon: "settings", text: "iPhoneの設定を開く")
        }
        .buttonStyle(MonoButtonStyle())
        .accessibilityIdentifier("caller-settings")
      }
      .padding(.vertical, 24).padding(.horizontal, 16)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.vertical, 1)
    .accessibilityIdentifier("integration-content")
    .background(.white)
    .safeAreaInset(edge: .top, spacing: 0) {
      if let problem = model.problem {
        VStack(spacing: 0) {
          Text(problem).font(.callout).fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading).padding(16)
            .accessibilityIdentifier("sync-error")
          Rectangle().fill(.black).frame(height: 1)
        }.foregroundStyle(.black).background(.white)
      }
    }
    .navigationTitle("設定").navigationBarTitleDisplayMode(.inline)
    .task { await model.refresh() }
  }
}

/// Marks on and off with a filled or empty circle beside the word, and shows the other states as words.
private struct CallerStatusLabel: View {
  let status: CallerStatus

  private var word: String {
    switch status {
    case .checking: "確認しています"
    case .on: "許可しています"
    case .onRetrying: "許可しています・反映できませんでした。次に開いたときにやり直します"
    case .off: "まだ許可していません"
    case .unknown: "確認できません"
    }
  }

  private var symbol: String? {
    status.isOn ? "checkmark.circle.fill" : status == .off ? "circle" : nil
  }

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      if let symbol {
        Image(systemName: symbol).imageScale(.large).accessibilityHidden(true)
      }
      Text(word).fixedSize(horizontal: false, vertical: true)
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("caller-state")
  }
}
