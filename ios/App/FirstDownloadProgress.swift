import PhonebookCore
import SwiftUI

/// The first download's status: one heading, one bar that never empties, and three steps with the time line under the current one.
struct FirstDownloadProgress: View {
  let wait: WaitDisplay
  let fraction: Double
  /// Nothing needs receiving, so the heading says preparing and the receive step shows as done.
  let preparing: Bool
  /// The search start screen shows the heading, and the ready step's large title carries the same words.
  let showsHeading: Bool

  static func heading(preparing: Bool) -> String {
    preparing ? "アプリで使うデータを準備しています" : "アプリで使うデータを受け取っています"
  }
  static let steps = ["データを受け取る", "さがせるように整える", "電話の相手が分かるようにする"]

  /// What the line under the current step says, one entry per line.
  static func timeLines(_ wait: WaitDisplay) -> [String] {
    switch wait.line {
    case .measuring: ["かかる時間を計っています"]
    case .countdown: ["あと\(wait.number)秒"]
    case .longer: ["時間がかかっています", "あと\(wait.number)分ほど"]
    case .almostDone: ["まもなく終わります"]
    case .weakSignal: ["電波が弱いようです", "つながると、続きから受け取ります。"]
    }
  }

  private var percent: Int { Int((min(max(fraction, 0), 1) * 100).rounded(.down)) }
  private var current: Int {
    min(max(wait.shown, preparing ? 1 : 0), Self.steps.count - 1)
  }

  var body: some View {
    let lines = Self.timeLines(wait)
    let heading = Self.heading(preparing: preparing)
    VStack(alignment: .leading, spacing: 20) {
      VStack(alignment: .leading, spacing: 12) {
        if showsHeading {
          Text(heading).font(.headline).fixedSize(horizontal: false, vertical: true)
        }
        ProgressTrack(fraction: fraction)
      }
      VStack(alignment: .leading, spacing: 12) {
        ForEach(Self.steps.indices, id: \.self) { index in
          DownloadStep(
            label: Self.steps[index],
            status: index < current ? .done : index == current ? .current : .pending,
            timeLines: index == current ? lines : [])
        }
      }
      Text("次からは、すぐに使えます。").font(.callout).fixedSize(horizontal: false, vertical: true)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(heading)
    .accessibilityValue(
      (["\(percent)パーセント", Self.steps[current]] + lines).joined(separator: "、")
    )
    .accessibilityIdentifier("sync-progress")
  }
}

/// One continuous bar: an ink fill inside a surface track with an ink outline.
private struct ProgressTrack: View {
  let fraction: Double

  var body: some View {
    GeometryReader { geometry in
      ZStack(alignment: .leading) {
        Rectangle().fill(.ink)
          .frame(width: max(0, geometry.size.width * min(max(fraction, 0), 1)))
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
      .background(.surface)
      .clipShape(RoundedRectangle(cornerRadius: 3))
      .overlay { RoundedRectangle(cornerRadius: 3).strokeBorder(.ink, lineWidth: 1) }
    }
    .frame(height: 6)
  }
}

private struct DownloadStep: View {
  enum Status { case done, current, pending }

  let label: String
  let status: Status
  let timeLines: [String]
  @ScaledMetric private var iconSize: CGFloat = 22

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      icon.frame(width: iconSize, height: iconSize)
      VStack(alignment: .leading, spacing: 2) {
        Text(label).font(status == .current ? .body.weight(.semibold) : .body)
          .fixedSize(horizontal: false, vertical: true)
        ForEach(timeLines, id: \.self) { line in
          Text(line).font(.subheadline).monospacedDigit()
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }

  @ViewBuilder private var icon: some View {
    switch status {
    case .done: Image(systemName: "checkmark.circle.fill").resizable().scaledToFit()
    case .current: DesignIcon(name: "circle-half-filled")
    case .pending: Image(systemName: "circle").resizable().scaledToFit()
    }
  }
}

/// The notice over the start button.
/// A transfer's size turns bold with the info icon on an expensive or constrained path, and data in the app needs no network.
struct DataSizeNotice: View {
  let notice: WelcomeNotice
  let costlyPath: Bool

  private var prominent: Bool {
    if case .size = notice { costlyPath } else { false }
  }

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      if prominent { DesignIcon(name: "info") }
      VStack(alignment: .leading, spacing: 0) {
        switch notice {
        case .noTransfer:
          Text("データはアプリに入っています。")
          Text("通信せずに準備できます。")
        case .size(let bytes):
          Text("受け取るデータは約\(DownloadSchedule.megabytes(bytes))MBです。")
          Text("Wi-Fiなどの速い回線につなぐと、早く終わります。")
        }
      }
      .font(prominent ? .body.weight(.semibold) : .body)
      .fixedSize(horizontal: false, vertical: true)
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("data-size-notice")
  }
}
