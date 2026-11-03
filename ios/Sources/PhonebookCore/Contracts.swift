public enum InputError: Error, Equatable, Sendable {
  case invalidPrefecture
  case invalidSnapshot
  case invalidPhone
}

public struct PrefectureCode: Hashable, Codable, Sendable, Comparable {
  public let rawValue: String

  public init(_ value: String) throws {
    guard value.utf8.count == 2, value.utf8.allSatisfy({ (48...57).contains($0) }),
      value >= "01", value <= "47"
    else { throw InputError.invalidPrefecture }
    rawValue = value
  }

  public init(from decoder: any Decoder) throws {
    try self.init(decoder.singleValueContainer().decode(String.self))
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }

  public static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
}

public struct SnapshotID: Hashable, Codable, Sendable {
  public let rawValue: String

  public init(_ value: String) throws {
    guard value.utf8.count == 64,
      value.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) })
    else { throw InputError.invalidSnapshot }
    rawValue = value
  }

  public init(from decoder: any Decoder) throws {
    try self.init(decoder.singleValueContainer().decode(String.self))
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }
}

public struct CanonicalPhone: Hashable, Codable, Sendable {
  public let rawValue: String
  public let number: Int64

  public init(_ value: String) throws {
    let digits = value.dropFirst()
    guard value.first == "+", digits.hasPrefix("81"),
      digits.count == 11 || digits.count == 12,
      digits.dropFirst(2).first != "0",
      digits.utf8.allSatisfy({ (48...57).contains($0) }),
      let parsed = Int64(digits)
    else { throw InputError.invalidPhone }
    rawValue = value
    number = parsed
  }

  public init(from decoder: any Decoder) throws {
    try self.init(decoder.singleValueContainer().decode(String.self))
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }
}

public enum PublicationDecision: Equatable, Sendable {
  case retain, publish

  public static func decide(current: Bool, complete: Bool, snapshot: Bool, records: Bool) -> Self {
    current && complete && snapshot && records ? .publish : .retain
  }
}

public enum CallerLabel {
  public static func make(names: [String], category: String) -> String {
    // Most numbers belong to one row, and a single name is its own unique list.
    if names.count == 1 { return "\(names[0])（\(category)）" }
    let unique = Set(names).sorted()
    if unique.count == 1, let name = unique.first { return "\(name)（\(category)）" }
    return "公共施設（\(unique.count)つの名称で登録）"
  }
}
