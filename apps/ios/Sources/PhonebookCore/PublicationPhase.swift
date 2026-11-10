public enum PublicationEvent: String, Codable, CaseIterable, Sendable {
  case prepare, beginActivation, confirmActive, confirmInactive, abort
}

public enum PublicationPhase: String, Codable, CaseIterable, Sendable {
  case staging, prepared, uncertain, active, discarded

  public var canDiscard: Bool { self == .staging || self == .prepared || self == .discarded }

  public func applying(_ event: PublicationEvent) -> Self {
    switch (self, event) {
    case (.staging, .prepare): .prepared
    case (.staging, .abort), (.prepared, .abort): .discarded
    case (.prepared, .beginActivation): .uncertain
    case (.uncertain, .confirmActive): .active
    case (.uncertain, .confirmInactive): .prepared
    default: self
    }
  }
}
