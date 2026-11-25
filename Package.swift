// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "open3dpc",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [.library(name: "Open3DPCKit", targets: ["Open3DPCKit"])],
    targets: [
        .target(name: "Open3DPCKit", path: "swift/Sources/Open3DPCKit"),
        .testTarget(name: "Open3DPCKitTests", dependencies: ["Open3DPCKit"], path: "swift/Tests/Open3DPCKitTests"),
    ]
)
