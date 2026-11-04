import SwiftUI
import UIKit

/// The app's only two colors, which swap in the dark appearance: white surfaces with black ink, or black surfaces with white ink.
extension ShapeStyle where Self == Color {
  static var surface: Color { Color(uiColor: Palette.surface) }
  static var ink: Color { Color(uiColor: Palette.ink) }
}

enum Palette {
  static let surface = UIColor { $0.userInterfaceStyle == .dark ? .black : .white }
  static let ink = UIColor { $0.userInterfaceStyle == .dark ? .white : .black }
}
