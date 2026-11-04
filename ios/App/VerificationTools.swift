#if PHONEBOOK_VERIFICATION_TOOLS
  import PhonebookCore
  import PhonebookKit
  import SwiftUI

  /// The QA build's test number, which the owner saves to check calling and caller names on a real iPhone.
  @Observable @MainActor
  final class VerificationNumberModel {
    static let defaultLabel = "確認用の番号"

    var telephone = ""
    var label = VerificationNumberModel.defaultLabel
    private(set) var saved: CallerEntry?
    private(set) var message: String?
    private(set) var working = false

    init() {
      saved = VerificationNumberStore.load()
      if let saved {
        telephone = saved.display
        label = saved.label
      }
    }

    /// The saved entry when the search query matches it.
    func match(_ query: String) -> CallerEntry? {
      guard let saved, saved.matches(query: query) else { return nil }
      return saved
    }

    func save(_ integration: IntegrationModel) async {
      let entry: CallerEntry
      do {
        entry = try CallerEntry(telephone: telephone, label: label)
      } catch CallerEntry.Failure.telephone {
        tell("電話番号を、03-0000-0000のような形で入れてください。")
        return
      } catch {
        tell(
          label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "名前を入れてください。" : "名前を短くしてください。")
        return
      }
      working = true
      defer { working = false }
      do { try VerificationNumberStore.save(entry) } catch {
        tell("保存できませんでした。もう一度「保存する」を押してください。")
        return
      }
      saved = entry
      telephone = entry.display
      label = entry.label
      tell("保存しました。" + Self.reloaded(await integration.reloadCallerNames()))
    }

    /// Words the reload result, with the code that iOS returned, so a device check can report it.
    static func reloaded(_ reload: CallerReload) -> String {
      let code = reload.code.map { "（iPhoneの返答のコード：\($0)）" } ?? ""
      switch reload.status {
      case .on: return "iPhoneに反映しました。"
      case .off: return "iPhoneの設定で許可すると、電話がかかってきたときにこの名前が出ます。"
      case .loading: return "iPhoneが読み込んでいる途中です。読み込みが終わると反映します。\(code)"
      case .checking, .onRetrying, .unknown: return "iPhoneへの反映は未確認です。\(code)"
      }
    }

    func clear(_ integration: IntegrationModel) async {
      working = true
      defer { working = false }
      do { try VerificationNumberStore.clear() } catch {
        tell("消せませんでした。もう一度「消す」を押してください。")
        return
      }
      saved = nil
      telephone = ""
      label = Self.defaultLabel
      let reload = await integration.reloadCallerNames()
      tell(reload.status == .off ? "消しました。" : "消しました。" + Self.reloaded(reload))
    }

    private func tell(_ text: String) {
      message = text
      AccessibilityAnnouncement.post(text)
    }
  }

  /// The QA build's screen for the owner's test number and the automatic update status.
  struct VerificationToolsScreen: View {
    @Bindable var model: VerificationNumberModel
    @Bindable var integration: IntegrationModel

    var body: some View {
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          VStack(alignment: .leading, spacing: 12) {
            Text("確認用の電話番号").font(.headline).accessibilityAddTraits(.isHeader)
            Text("入れた番号と名前は、このiPhoneの中に保存します。").font(.callout)
            Text("保存すると、検索の結果と、電話がかかってきたときの画面に、この名前が出ます。").font(.callout)
            LabeledField(
              label: "電話番号", text: $model.telephone, telephone: true,
              identifier: "verification-telephone")
            LabeledField(label: "名前", text: $model.label, identifier: "verification-label")
            if let message = model.message {
              Text(message).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("verification-message")
            }
            Button {
              Task { await model.save(integration) }
            } label: {
              IconLabel(icon: "check", text: "保存する")
            }
            .buttonStyle(MonoButtonStyle(prominent: true))
            .disabled(model.working)
            .accessibilityIdentifier("verification-save")
            Button {
              Task { await model.clear(integration) }
            } label: {
              IconLabel(icon: "x", text: "消す")
            }
            .buttonStyle(MonoButtonStyle())
            .disabled(model.working)
            .accessibilityIdentifier("verification-clear")
          }
          .padding(.vertical, 24)
          Rectangle().fill(.black).frame(height: 1)
          AutomaticUpdateStatus(integration: integration).padding(.vertical, 24)
          Rectangle().fill(.black).frame(height: 1)
          Text("この画面は、QA用のビルドで使います。").font(.footnote).padding(.vertical, 24)
        }
        .padding(.horizontal, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .scrollDismissesKeyboard(.interactively)
      .background(.white)
      .accessibilityIdentifier("verification-tools")
      .navigationTitle("QA用の確認")
      .navigationBarTitleDisplayMode(.inline)
    }
  }

  private struct LabeledField: View {
    let label: String
    @Binding var text: String
    var telephone = false
    let identifier: String

    var body: some View {
      VStack(alignment: .leading, spacing: 6) {
        Text(label).font(.body.weight(.semibold)).accessibilityHidden(true)
        TextField("", text: $text)
          .keyboardType(telephone ? .numbersAndPunctuation : .default)
          .textContentType(telephone ? .telephoneNumber : nil)
          .autocorrectionDisabled()
          .textInputAutocapitalization(.never)
          .padding(.horizontal, 14)
          .frame(minHeight: 44)
          .overlay { Rectangle().strokeBorder(.black, lineWidth: 1) }
          .accessibilityLabel(label)
          .accessibilityIdentifier(identifier)
      }
    }
  }

  /// The saved data's date, the last automatic check, the next due time, any problem, and an update action.
  private struct AutomaticUpdateStatus: View {
    @Bindable var integration: IntegrationModel

    private var dataDate: String {
      integration.manifest?.updatedAt.formatted(date: .long, time: .omitted) ?? "受け取る前です"
    }

    private var lastCheck: String {
      BackgroundRefresh.lastAttempt?.formatted(date: .long, time: .shortened) ?? "なし"
    }

    private var nextDue: String {
      guard let manifest = integration.manifest else { return "データを受け取ったあとに決まります" }
      let next = RefreshPolicy.nextDate(
        updatedAt: manifest.updatedAt, lastAttempt: BackgroundRefresh.lastAttempt)
      return next.formatted(date: .long, time: .shortened) + "から"
    }

    var body: some View {
      VStack(alignment: .leading, spacing: 12) {
        Text("データの自動の受け取り").font(.headline).accessibilityAddTraits(.isHeader)
        Text("データの日付：\(dataDate)")
        Text("前に確かめた日時：\(lastCheck)")
        Text("次に受け取る日時：\(nextDue)")
        Text("問題：\(integration.problem ?? integration.stopped ?? "なし")")
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("verification-problem")
        if integration.costlyPath {
          Text("モバイルデータ通信や省データモードのときは、Wi-Fiにつないでから押してください。")
            .font(.callout).fixedSize(horizontal: false, vertical: true)
        }
        Button {
          integration.updateNow()
        } label: {
          IconLabel(icon: "download", text: integration.busy ? "受け取っています" : "いま受け取る")
        }
        .buttonStyle(MonoButtonStyle())
        .disabled(integration.busy)
        .accessibilityIdentifier("verification-update")
      }
    }
  }

  /// The saved test number as one search result with the standard call button.
  struct VerificationResult: View {
    let entry: CallerEntry

    var body: some View {
      VStack(alignment: .leading, spacing: 0) {
        HStack(spacing: 6) {
          DesignIcon(name: "phone", size: 16)
          Text("QA用").bold()
          Text("1件")
        }
        .font(.title3).padding(.top, 24).padding(.bottom, 8)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("QA用 1件")
        .accessibilityAddTraits(.isHeader)
        Rectangle().fill(.black).frame(height: 2)
        VStack(alignment: .leading, spacing: 10) {
          Text(entry.label).font(.title3.bold()).multilineTextAlignment(.leading)
            .accessibilityAddTraits(.isHeader)
          PhoneActions(phone: Phone(display: entry.display, e164: entry.phone))
        }
        .padding(.vertical, 16)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("verification-result")
        Rectangle().fill(.black).frame(height: 1)
      }
    }
  }
#endif
