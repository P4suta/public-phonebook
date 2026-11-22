import PhonebookCore
import PhonebookKit
import SwiftUI

struct SettingsScreen: View {
  @Bindable var model: IntegrationModel
  let directory: DirectoryModel
  @Environment(\.dismiss) private var dismiss
  #if PHONEBOOK_VERIFICATION_TOOLS
    @Environment(VerificationNumberModel.self) private var verification
  #endif

  var body: some View {
    Form {
      Section {
        CallerStatusLabel(status: model.callerStatus)
        Text("アプリにある番号から電話がかかってきたとき、施設の名前が出ます。")
          .fixedSize(horizontal: false, vertical: true)
        Button("設定を開く", systemImage: "gearshape") { model.openCallerSettings() }
          .accessibilityIdentifier("caller-settings")
      } header: {
        Text("着信時の施設名表示").foregroundStyle(TintShapeStyle())
      } footer: {
        Text("設定で「\(AppIdentity.displayName)」を許可してください。").font(.footnote)
          .foregroundStyle(TintShapeStyle())
          .fixedSize(horizontal: false, vertical: true)
      }
      if let problem = model.problem {
        Text(problem).accessibilityIdentifier("sync-error")
      }
      Section {
        NavigationLink {
          AboutScreen(model: directory, integration: model)
        } label: {
          Label("Public Phonebookについて", systemImage: "info.circle")
            .fixedSize(horizontal: false, vertical: true)
        }
        NavigationLink {
          SourcesScreen(categories: directory.categories)
        } label: {
          Label("データのもと", systemImage: "books.vertical")
            .fixedSize(horizontal: false, vertical: true)
        }
        NavigationLink {
          LicenseScreen()
        } label: {
          Label("ライセンス", systemImage: "doc.text")
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      #if PHONEBOOK_VERIFICATION_TOOLS
        Section {
          NavigationLink {
            VerificationToolsScreen(model: verification, integration: model)
          } label: {
            Label("QA用の確認", systemImage: "wrench.and.screwdriver")
              .fixedSize(horizontal: false, vertical: true)
          }
        }
      #endif
    }
    .lineLimit(nil)
    .accessibilityIdentifier("integration-content")
    .navigationTitle("設定")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .confirmationAction) {
        Button("閉じる", systemImage: "xmark") { dismiss() }
          .accessibilityIdentifier("close-settings")
      }
    }
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
    case .loading: "準備しています"
    case .onRetrying: "アプリを開き直すと、もう一度準備します"
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
