#if PHONEBOOK_VERIFICATION_TOOLS
  import PhonebookCore
  import PhonebookKit
  import SwiftUI

  /// Captures the requested telephone URL during simulator UI tests.
  struct VerificationCallHandoff: ViewModifier {
    @State private var telephoneURL: URL?

    func body(content: Content) -> some View {
      if ProcessInfo.processInfo.arguments.contains("--verify-call-handoff") {
        content
          .environment(
            \.openURL,
            OpenURLAction { url in
              guard url.scheme == "tel" else { return .systemAction }
              telephoneURL = url
              return .handled
            }
          )
          .alert(
            "Call handoff",
            isPresented: Binding(
              get: { telephoneURL != nil }, set: { if !$0 { telephoneURL = nil } })
          ) {
            Button("OK", role: .cancel) {}
          } message: {
            Text(telephoneURL?.absoluteString ?? "")
          }
      } else {
        content
      }
    }
  }

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
      case .off: return "iPhoneの設定で「\(AppIdentity.displayName)」を許可してください。"
      case .loading: return "iPhoneが読みこんでいます。終わると反映します。\(code)"
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

    func verifyReplacement(_ integration: IntegrationModel) async {
      working = true
      defer { working = false }
      let initial = await integration.reloadCallerNames()
      guard initial.status == .on else {
        tell(Self.reloaded(initial))
        return
      }
      do {
        let root = try VerificationNumberStore.container()
        _ = try VerificationNumberStore.prepareCallerProbe(in: root)
        let reply = await integration.reloadCallerNames()
        try VerificationNumberStore.clearCallerProbe(in: root)
        tell(reply.status == .on ? "全件の再登録が完了しました。" : Self.reloaded(reply))
      } catch { tell("確認の準備ができませんでした。データの準備が終わってから試してください。") }
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
      Form {
        Section("確認用の電話番号") {
          Text("入れた番号と名前は、iPhoneの中に保存します。").font(.callout)
          Text("保存した名前が、検索の結果と着信時の画面に出ます。").font(.callout)
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
            Label("保存する", systemImage: "checkmark")
          }
          .disabled(model.working)
          .accessibilityIdentifier("verification-save")
          Button {
            Task { await model.clear(integration) }
          } label: {
            Label("消す", systemImage: "xmark")
          }
          .disabled(model.working)
          .accessibilityIdentifier("verification-clear")
          Text("確認用の差分で、施設名の再登録を試します。")
            .font(.callout)
          Button {
            Task { await model.verifyReplacement(integration) }
          } label: {
            Label("全件の再登録を確認する", systemImage: "checkmark")
          }
          .disabled(model.working)
          .accessibilityIdentifier("verification-caller-replacement")
        }
        Section {
          AutomaticUpdateStatus(integration: integration)
        } footer: {
          Text("QA用のアプリで使う画面です。")
        }
      }
      .scrollDismissesKeyboard(.interactively)
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
          .frame(minHeight: 44)
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

    private var answeredAt: Date? {
      integration.updateRecord.state.answeredAt.map {
        Date(timeIntervalSince1970: TimeInterval($0))
      }
    }

    private var lastCheck: String {
      answeredAt?.formatted(date: .long, time: .shortened) ?? "なし"
    }

    private var nextDue: String {
      guard integration.manifest != nil else { return "データを受け取ったあとに決まります" }
      guard let answeredAt else { return "次にアプリを開いたとき" }
      return answeredAt.addingTimeInterval(TimeInterval(UpdateCheck.intervalSeconds))
        .formatted(date: .long, time: .shortened) + "から"
    }

    private var waiting: String {
      integration.updateRecord.state.waiting == nil ? "なし" : "Wi-Fiなどにつながると受け取ります"
    }

    var body: some View {
      VStack(alignment: .leading, spacing: 12) {
        Text("データの自動の受け取り").font(.headline).accessibilityAddTraits(.isHeader)
        Text("データの日付：\(dataDate)")
        Text("前にたしかめた日時：\(lastCheck)")
        Text("次にたしかめる日時：\(nextDue)")
        Text("待っている受け取り：\(waiting)")
        Text("問題：\(integration.lastFailure ?? integration.stopped ?? "なし")")
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("verification-problem")
        Button {
          integration.updateNow()
        } label: {
          Label(integration.busy ? "受け取っています" : "いま受け取る", systemImage: "arrow.down.circle")
        }
        .disabled(integration.busy)
        .accessibilityIdentifier("verification-update")
      }
    }
  }

  /// The saved test number as one search result with the standard call button.
  struct VerificationResult: View {
    let entry: CallerEntry

    var body: some View {
      Section("QA用 1件") {
        let phone = Phone(display: entry.display, e164: entry.phone)
        HStack {
          VStack(alignment: .leading) {
            Text(entry.label).font(.headline)
            Text(phone.nationalDisplay).monospacedDigit().accessibilityIdentifier("phone-number")
          }
          Spacer()
          CallButton(phone: phone, iconOnly: true)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("verification-result")
      }
    }
  }
#endif
