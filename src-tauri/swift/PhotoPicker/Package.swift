// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "PhotoPicker",
    platforms: [.macOS(.v13)],
    products: [
        .library(
            name: "PhotoPicker",
            type: .static,
            targets: ["PhotoPicker"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/Brendonovich/swift-rs", from: "1.0.5")
    ],
    targets: [
        .target(
            name: "PhotoPicker",
            dependencies: [
                .product(name: "SwiftRs", package: "swift-rs")
            ]
        )
    ]
)
