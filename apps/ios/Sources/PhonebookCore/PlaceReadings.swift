import Foundation

public struct PlaceReadings: Sendable {
  public struct Matches: Sendable, Equatable {
    public let prefectures: [String]
    public let categories: [String]
  }

  public enum InvalidData: Error { case readings }

  private let prefectures: [(code: String, form: String)]
  private let categories: [String: [String]]

  public init(prefectures: [String], categories: [String: [String]]) throws {
    func validKana(_ value: String) -> Bool {
      (2...128).contains(value.utf16.count)
        && value.unicodeScalars.allSatisfy { (0x30A1...0x30F6).contains($0.value) || $0 == "ー" }
    }
    guard prefectures.count == 47, prefectures.allSatisfy(validKana),
      categories.keys.allSatisfy({
        $0.range(of: "^[a-z][a-z0-9_]{0,63}$", options: .regularExpression) != nil
      }),
      categories.values.allSatisfy({ (1...8).contains($0.count) && $0.allSatisfy(validKana) })
    else { throw InvalidData.readings }
    self.prefectures = prefectures.enumerated().map {
      (String(format: "%02d", $0.offset + 1), SearchInput.searchForm($0.element))
    }
    self.categories = categories.mapValues { $0.map(SearchInput.searchForm) }
  }

  public func matching(_ word: String) -> Matches {
    guard Self.admits(word) else { return Matches(prefectures: [], categories: []) }
    return Matches(
      prefectures: prefectures.filter { $0.form.hasPrefix(word) }.map(\.code),
      categories: categories.filter { $0.value.contains { $0.hasPrefix(word) } }.keys.sorted())
  }

  public static func admits(_ word: String) -> Bool {
    let values = word.unicodeScalars.map(\.value)
    func kana(_ value: UInt32) -> Bool {
      (0x3041...0x3096).contains(value) || value == 0x309D || value == 0x309E
    }
    return values.count >= 2 && values.contains(where: kana)
      && values.allSatisfy { kana($0) || $0 == 0x2D }
  }
}
