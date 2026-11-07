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
    .target(name: "PhonebookKit", dependencies: ["PhonebookCore", "CSQLite"]),
    // The build runs this tool to admit the bundled archive, and the app never links it.
    .executableTarget(
      name: "BundledAdmission",
      dependencies: ["PhonebookCore", "PhonebookKit"],
      path: "Admission"),
    .testTarget(
      name: "PhonebookCoreTests", dependencies: ["PhonebookCore"],
      resources: [
        .copy("PublicationContract.json"), .copy("WaitContract.json"),
        .copy("UpdateContract.json"), .copy("SearchContract.json"),
      ]),
    .testTarget(
      name: "PhonebookKitTests", dependencies: ["PhonebookKit"],
      resources: [.copy("DirectoryContract.json")]),
  ],
  swiftLanguageModes: [.v6]
)
