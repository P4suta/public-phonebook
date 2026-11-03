import Foundation

/// One telephone number and caller label that a person typed, checked like a search query and a caller file record.
public struct CallerEntry: Codable, Equatable, Sendable {
  public enum Failure: Error, Equatable, Sendable {
    case telephone, label
  }

  /// The telephone number as typed, which keeps its hyphens for display.
  public let display: String
  public let phone: CanonicalPhone
  public let label: String

  public init(telephone: String, label: String) throws {
    let display = telephone.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let normalized = SearchInput.normalizedPhone(display),
      let phone = try? CanonicalPhone(normalized)
    else { throw Failure.telephone }
    let label = label.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !label.isEmpty, label.utf8.count <= CallerFile.maximumLabelBytes,
      !label.unicodeScalars.contains(where: { $0.properties.generalCategory == .control })
    else { throw Failure.label }
    self.display = display
    self.phone = phone
    self.label = label
  }

  /// Matches a query the way directory search does: a complete telephone number, or part of the normalized label.
  public func matches(query: String) -> Bool {
    if let telephone = SearchInput.normalizedPhone(query) { return telephone == phone.rawValue }
    return SearchInput.rank(
      name: SearchInput.normalizedName(label), query: SearchInput.normalizedName(query)) != nil
  }

  private enum CodingKeys: String, CodingKey {
    case telephone, label
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    try self.init(
      telephone: container.decode(String.self, forKey: .telephone),
      label: container.decode(String.self, forKey: .label))
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(display, forKey: .telephone)
    try container.encode(label, forKey: .label)
  }
}
