import CoreLocation
import Testing

@testable import PhonebookKit

private let library = CLLocationCoordinate2D(latitude: 35.6782, longitude: 139.7442)

/// Moves a coordinate north by a distance in meters, about 111,195 m per degree of latitude.
private func north(_ meters: Double, of point: CLLocationCoordinate2D) -> CLLocationCoordinate2D {
  CLLocationCoordinate2D(latitude: point.latitude + meters / 111_195, longitude: point.longitude)
}

@Test func choosesTheNearestPlaceWithinTheRadius() {
  let places = [north(250, of: library), north(7, of: library), north(120, of: library)]
  #expect(PlaceMatch.nearest(to: library, among: places) == 1)
}

@Test func rejectsPlacesOutsideTheRadiusEvenWhenTheyAreTheOnlyOnes() {
  // The probe found same-name places 24 km and 2,064 km away from the address.
  let places = [north(24_000, of: library), north(2_064_000, of: library), north(301, of: library)]
  #expect(PlaceMatch.nearest(to: library, among: places) == nil)
  #expect(PlaceMatch.nearest(to: library, among: []) == nil)
}

@Test func acceptsThePlaceAtTheRadiusAndKeepsTheFirstOfEqualDistances() {
  #expect(PlaceMatch.nearest(to: library, among: [north(299, of: library)]) == 0)
  #expect(PlaceMatch.nearest(to: library, among: [library, library]) == 0)
}

@Test(arguments: 0..<200)
func neverChoosesAPlaceFartherThanTheRadiusOrFartherThanAnotherCandidate(seed: Int) {
  var generator = SplitMix64(seed: UInt64(seed))
  let places = (0..<Int(generator.next() % 6)).map { _ in
    north(Double(generator.next() % 1_000), of: library)
  }
  let anchor = CLLocation(latitude: library.latitude, longitude: library.longitude)
  let distances = places.map {
    anchor.distance(from: CLLocation(latitude: $0.latitude, longitude: $0.longitude))
  }
  if let chosen = PlaceMatch.nearest(to: library, among: places) {
    #expect(distances[chosen] <= PlaceMatch.radius)
    #expect(distances.allSatisfy { $0 >= distances[chosen] })
  } else {
    #expect(distances.allSatisfy { $0 > PlaceMatch.radius })
  }
}

private struct SplitMix64 {
  private var state: UInt64
  init(seed: UInt64) { state = seed }
  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var value = state
    value = (value ^ (value >> 30)) &* 0xBF58_476D_1CE4_E5B9
    value = (value ^ (value >> 27)) &* 0x94D0_49BB_1331_11EB
    return value ^ (value >> 31)
  }
}
