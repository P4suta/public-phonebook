// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "Phonebook",
  platforms: [.iOS(.v18), .macOS(.v15)],
  products: [
    .library(name: "PhonebookCore", targets: ["PhonebookCore"]),
    .library(name: "PhonebookKit", targets: ["PhonebookKit"]),
  ],
  targets: [
    .target(name: "PhonebookCore"),
    .systemLibrary(name: "CSQLite"),
    // Forgiving ranking runs only in QA builds, so it stays outside the shipped core mutation scope.
    .target(name: "PhonebookRanking", dependencies: ["PhonebookCore"]),
    .target(name: "PhonebookKit", dependencies: ["PhonebookCore", "PhonebookRanking", "CSQLite"]),
    // The build runs this tool to admit the bundled archive, and the app never links it.
    .executableTarget(
      name: "BundledAdmission",
      dependencies: ["PhonebookCore", "PhonebookRanking", "PhonebookKit"],
      path: "Admission"),
    .testTarget(
      name: "PhonebookCoreTests", dependencies: ["PhonebookCore"],
      resources: [
        .copy("PublicationContract.json"), .copy("WaitContract.json"),
        .copy("UpdateContract.json"), .copy("SearchContract.json"),
      ]),
    .testTarget(
      name: "PhonebookKitTests", dependencies: ["PhonebookKit", "PhonebookRanking"],
      resources: [.copy("DirectoryContract.json")]),
  ],
  swiftLanguageModes: [.v6]
)
