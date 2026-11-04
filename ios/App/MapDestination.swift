import MapKit

/// Opens a facility in Apple Maps at the point of its address, as a map item named after the facility.
/// A search by the facility name found shops named after it, so the app geocodes only the address.
@MainActor
enum MapDestination {
  static func open(name: String, address: String) async -> Bool {
    guard let item = await geocode(address) else { return false }
    item.name = name
    return item.openInMaps()
  }

  private static func geocode(_ address: String) async -> MKMapItem? {
    if #available(iOS 26, *) {
      // https://developer.apple.com/documentation/mapkit/mkgeocodingrequest
      return try? await MKGeocodingRequest(addressString: address)?.mapItems.first
    }
    // iOS 26 deprecates CLGeocoder, so earlier versions search MapKit for the address alone:
    // https://developer.apple.com/documentation/corelocation/clgeocoder
    let request = MKLocalSearch.Request()
    request.naturalLanguageQuery = address
    request.resultTypes = .address
    return try? await MKLocalSearch(request: request).start().mapItems.first
  }
}
