# Reading Open3DPC on iOS

`Open3DPCKit` is a Swift package with no dependencies beyond Apple frameworks (Core Image, Vision,
Core Video). iOS 15 and macOS 12 or later.

## 1. Add the package

In Xcode: File, Add Package Dependencies, `https://github.com/Open3DPC/open3dpc`, branch `main`
(there is no tagged release yet), product `Open3DPCKit`. Or in `Package.swift`:

```swift
dependencies: [.package(url: "https://github.com/Open3DPC/open3dpc", branch: "main")],
targets: [.target(name: "App", dependencies: [.product(name: "Open3DPCKit", package: "open3dpc")])]
```

Add `NSCameraUsageDescription` to the app's `Info.plist`.

## 2. Show the scanner

Copy [examples/ios/Open3DPCScannerView.swift](../examples/ios/Open3DPCScannerView.swift) into the app
and use it:

```swift
Open3DPCScannerView(
    options: .init(payloadLengths: [14], geometries: [.init(height: 4, width: 6)])
) { code in
    print(code.bits, code.value ?? 0)   // 10011100001111 9999
}
```

## 3. Or put the reader into a camera you already have

The reader takes frames from an `AVCaptureVideoDataOutput`. It can run beside an
`AVCaptureMetadataOutput` in the same session, so adding it does not change your QR scanning.

```swift
let reader = Open3DPCReader(options: .init(payloadLengths: [14]))
var stabilizer = Open3DPCStabilizer()

func captureOutput(_ output: AVCaptureOutput, didOutput buffer: CMSampleBuffer, from connection: AVCaptureConnection) {
    guard let pixels = CMSampleBufferGetImageBuffer(buffer) else { return }
    if let code = stabilizer.observe(reader.read(pixels, regionOfInterest: region)) {
        // confirmed: seen in two frames, alone in the viewfinder
    }
}
```

What has to be right:

| Setting | Why |
|---|---|
| `videoSettings` = `420YpCbCr8BiPlanarFullRange` | The reader takes luma from plane 0. Other formats read as nothing |
| `alwaysDiscardsLateVideoFrames = true` | A read can take longer than a frame interval |
| One serial queue for the reader and the stabilizer | Both follow codes from frame to frame |
| `regionOfInterest` = the viewfinder | Less work, and no reading of a neighbouring code |
| Continuous focus and exposure, point of interest in the centre | Codes are small and held close |
| A virtual device (triple or dual wide), zoomed to its first switch-over factor | It can focus closer by switching lenses; at zoom 1 it is the ultra-wide lens |
| `LowLightTorchPolicy` | In the dark there is no contrast. Light the torch below full power |

`Options` decides what this session reads: `payloadLengths` (lengths in bits) and `geometries`
(`.init(height:width:)`, rows by columns). Both default to any; set them to the codes you print
([why](../README.md#the-contract-the-length-and-the-shape-you-print)).

`regionOfInterest` and `corners` are normalised with the origin at the **lower left**, as in Vision.
From a preview layer:

```swift
let captured = previewLayer.metadataOutputRectConverted(fromLayerRect: viewfinder)
let region = CGRect(x: captured.minX, y: 1 - captured.maxY, width: captured.width, height: captured.height)
```

The frame does not have to be turned upright: the code carries its own orientation.

## 4. Still images

`Open3DPCReader().read(cgImage)` reads a photo. It uses the same path as a frame and needs macOS or iOS.

## 5. Without a camera

`Open3DPC.encode(payload:geometry:)` and `Open3DPC.validate(_:)` are the format itself, for tests and
for your own generator.

## What to expect

A single frame may be refused even when the code is plain to see; a moving hand gives the reader the
next one. Some payloads are refused much more often: see
[Known limits of the readers](reader-pipeline.md#known-limits-of-the-readers). Distance, time to read
and success rate on real prints have not been measured.
