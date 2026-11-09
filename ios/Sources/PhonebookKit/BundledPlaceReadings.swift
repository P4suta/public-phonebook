import Foundation
import PhonebookCore

enum BundledPlaceReadings {
  private struct Source: Decodable {
    let prefectures: [[String]]
    let categories: [String: [String]]
  }

  static func load() throws -> PlaceReadings {
    guard let url = Bundle.module.url(forResource: "PlaceReadings", withExtension: "json") else {
      throw ImportError.invalidSnapshot
    }
    let source = try JSONDecoder().decode(Source.self, from: Data(contentsOf: url))
    guard source.prefectures.allSatisfy({ $0.count == 2 }) else {
      throw ImportError.invalidSnapshot
    }
    return try PlaceReadings(
      prefectures: source.prefectures.map { $0[1] }, categories: source.categories)
  }
}
