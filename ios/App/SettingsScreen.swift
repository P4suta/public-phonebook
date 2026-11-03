import PhonebookCore
import PhonebookKit
import SwiftUI

struct SettingsScreen: View {
  @Bindable var model: IntegrationModel

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        VStack(alignment: .leading, spacing: 12) {
          Text("全国の電話番号").font(.headline).accessibilityAddTraits(.isHeader)
          if let manifest = model.manifest {
            Text("保存した日：\(manifest.updatedAt.formatted(date: .long, time: .omitted))")
              .font(.callout).accessibilityIdentifier("saved-date")
          } else {
            Text("まだ保存していません。").font(.callout).accessibilityIdentifier("saved-date")
          }
          if model.progress != nil {
            SaveProgress(percent: model.percent)
            Button {
              model.cancel()
            } label: {
              IconLabel(icon: "x", text: "保存をやめる")
            }.buttonStyle(MonoButtonStyle())
          } else {
            Button {
              model.update()
            } label: {
              IconLabel(icon: "download", text: model.manifest == nil ? "今すぐ保存する" : "今すぐ更新する")
            }
            .buttonStyle(MonoButtonStyle(prominent: true))
            .accessibilityIdentifier("update-now")
            Text("月に1回くらい、自動で新しくします。").font(.footnote)
          }
        }.padding(.vertical, 24)
        Divider().overlay(.black)
        VStack(alignment: .leading, spacing: 12) {
          Text("着信に施設の名前を出す").font(.headline).accessibilityAddTraits(.isHeader)
          Text("iPhoneの設定で\(AppIdentity.displayName)をオンにすると、施設や窓口からの着信に名前を出します。")
            .font(.callout)
          Text("オンにしてから使えるようになるまで、20秒ほどかかります。")
            .font(.callout)
          Text("いまの状態：\(model.callerState)").accessibilityIdentifier("caller-state")
          Button {
            model.openCallerSettings()
          } label: {
            IconLabel(icon: "settings", text: "iPhoneの設定を開く")
          }.buttonStyle(MonoButtonStyle())
        }.padding(.vertical, 24)
      }.padding(.horizontal, 16).frame(maxWidth: .infinity, alignment: .leading)
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
