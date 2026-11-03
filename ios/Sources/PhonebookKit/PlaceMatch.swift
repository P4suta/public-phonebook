import CoreLocation

/// Chooses which place a map search found for a facility, given the point of its address.
public enum PlaceMatch {
  /// A found place counts as the facility only within this distance of its address.
  /// Map search treats its region as a hint, so a place with the same name can come back from another city.
  public static let radius: CLLocationDistance = 300

  /// Returns the index of the place nearest to the address within `radius`, or nil when none is that close.
  public static func nearest(
    to address: CLLocationCoordinate2D, among places: [CLLocationCoordinate2D]
  ) -> Int? {
    let anchor = CLLocation(latitude: address.latitude, longitude: address.longitude)
    var best: (index: Int, distance: CLLocationDistance)?
    for (index, place) in places.enumerated() {
      let distance = anchor.distance(
        from: CLLocation(latitude: place.latitude, longitude: place.longitude))
      guard distance.isFinite, distance <= radius else { continue }
      if best.map({ distance < $0.distance }) ?? true { best = (index, distance) }
    }
    return best?.index
  }
}
