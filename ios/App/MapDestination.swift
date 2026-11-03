import MapKit
import PhonebookKit

/// Opens a facility in Apple Maps: the place that map search finds by name near its address, or a pin at the address with its name.
@MainActor
enum MapDestination {
  /// Searching by name and address together returns only the address, so the address anchors a search for the name nearby.
  static func open(name: String, address: String) async -> Bool {
    guard let addressItem = await search(address, types: .address, region: nil).first else {
      return false
    }
    let anchor = coordinate(of: addressItem)
    let places = await search(
      name, types: .pointOfInterest,
      region: MKCoordinateRegion(
        center: anchor, latitudinalMeters: 2 * PlaceMatch.radius,
        longitudinalMeters: 2 * PlaceMatch.radius))
    if let index = PlaceMatch.nearest(to: anchor, among: places.map(coordinate(of:))) {
      return places[index].openInMaps()
    }
    addressItem.name = name
    return addressItem.openInMaps()
  }

  private static func search(
    _ query: String, types: MKLocalSearch.ResultType, region: MKCoordinateRegion?
  ) async -> [MKMapItem] {
    let request = MKLocalSearch.Request()
    request.naturalLanguageQuery = query
    request.resultTypes = types
    if let region { request.region = region }
    return (try? await MKLocalSearch(request: request).start().mapItems) ?? []
  }

  private static func coordinate(of item: MKMapItem) -> CLLocationCoordinate2D {
    if #available(iOS 26, *) { item.location.coordinate } else { item.placemark.coordinate }
  }
}
