// A minimal Open3DPC scanner for SwiftUI. Copy it into an app that depends on Open3DPCKit.
// Copyright 2026 Roman Simonov. Licensed under the Apache License, Version 2.0.

import AVFoundation
import Open3DPCKit
import SwiftUI
import UIKit

/// The camera with a square viewfinder; `onCode` runs on the main thread, once per confirmed code.
struct Open3DPCScannerView: UIViewRepresentable {
    let options: Open3DPCReader.Options
    let onCode: (Open3DPCReading) -> Void

    func makeUIView(context: Context) -> Open3DPCCameraView { Open3DPCCameraView(options: options, onCode: onCode) }
    func updateUIView(_ view: Open3DPCCameraView, context: Context) {}
    static func dismantleUIView(_ view: Open3DPCCameraView, coordinator: ()) { view.stop() }
}

final class Open3DPCCameraView: UIView, AVCaptureVideoDataOutputSampleBufferDelegate {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    private var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }

    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "open3dpc.session")
    /// The reader, the stabilizer and the torch policy live on this queue only.
    private let frameQueue = DispatchQueue(label: "open3dpc.frames", qos: .userInitiated)
    private let reader: Open3DPCReader
    private var stabilizer = Open3DPCStabilizer()
    private var torch = LowLightTorchPolicy()
    private var lastCodeAt: Date?
    private var delivered: [Bool]?
    private var region: CGRect?
    private var device: AVCaptureDevice?
    private let onCode: (Open3DPCReading) -> Void

    init(options: Open3DPCReader.Options, onCode: @escaping (Open3DPCReading) -> Void) {
        reader = Open3DPCReader(options: options)
        self.onCode = onCode
        super.init(frame: .zero)
        preview.session = session
        preview.videoGravity = .resizeAspectFill
        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            guard granted, let self else { return }
            self.sessionQueue.async { self.configure() }
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func stop() {
        sessionQueue.async { [session] in session.stopRunning() }
    }

    private func configure() {
        // A virtual device focuses close by switching lenses. On it, zoom 1 is the ultra-wide lens,
        // so start at the factor where the wide lens takes over.
        guard let camera = AVCaptureDevice.default(.builtInTripleCamera, for: .video, position: .back)
                ?? AVCaptureDevice.default(.builtInDualWideCamera, for: .video, position: .back)
                ?? AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
              let input = try? AVCaptureDeviceInput(device: camera) else { return }
        let output = AVCaptureVideoDataOutput()
        output.alwaysDiscardsLateVideoFrames = true
        output.videoSettings = [
            kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_420YpCbCr8BiPlanarFullRange),
        ]
        output.setSampleBufferDelegate(self, queue: frameQueue)

        session.beginConfiguration()
        if session.canSetSessionPreset(.high) { session.sessionPreset = .high }
        if session.canAddInput(input) { session.addInput(input) }
        if session.canAddOutput(output) { session.addOutput(output) }
        session.commitConfiguration()

        if (try? camera.lockForConfiguration()) != nil {
            if camera.isFocusModeSupported(.continuousAutoFocus) { camera.focusMode = .continuousAutoFocus }
            if camera.isFocusPointOfInterestSupported { camera.focusPointOfInterest = CGPoint(x: 0.5, y: 0.5) }
            if camera.isExposureModeSupported(.continuousAutoExposure) { camera.exposureMode = .continuousAutoExposure }
            if let wide = camera.virtualDeviceSwitchOverVideoZoomFactors.first {
                camera.videoZoomFactor = min(CGFloat(truncating: wide), camera.activeFormat.videoMaxZoomFactor)
            }
            camera.unlockForConfiguration()
        }
        frameQueue.async { self.device = camera }
        session.startRunning()
        DispatchQueue.main.async { self.setNeedsLayout() }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let side = min(bounds.width, bounds.height) * 0.7
        let viewfinder = CGRect(x: bounds.midX - side / 2, y: bounds.midY - side / 2, width: side, height: side)
        // Capture coordinates start at the top left, the reader's at the lower left.
        let captured = preview.metadataOutputRectConverted(fromLayerRect: viewfinder)
        let region = CGRect(x: captured.minX, y: 1 - captured.maxY, width: captured.width, height: captured.height)
            .intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
        frameQueue.async { self.region = region.isNull || region.isEmpty ? nil : region }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput buffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pixels = CMSampleBufferGetImageBuffer(buffer) else { return }
        let now = Date()
        let readings = reader.read(pixels, regionOfInterest: region)
        if !readings.isEmpty { lastCodeAt = now }
        lightTorchIfDark(at: now)

        guard let code = stabilizer.observe(readings, at: now) else {
            delivered = nil
            return
        }
        guard delivered != code.payload else { return }
        delivered = code.payload
        DispatchQueue.main.async { self.onCode(code) }
    }

    private func lightTorchIfDark(at now: Date) {
        guard let device, device.hasTorch, let brightness = LowLightTorchPolicy.brightness(
            aperture: Double(device.lensAperture), exposureSeconds: device.exposureDuration.seconds, iso: Double(device.iso)
        ), torch.shouldLight(brightness: brightness, at: now, codeSeenAt: lastCodeAt, torchIsOn: device.isTorchActive),
            (try? device.lockForConfiguration()) != nil else { return }
        try? device.setTorchModeOn(level: min(LowLightTorchPolicy.torchLevel, AVCaptureDevice.maxAvailableTorchLevel))
        device.unlockForConfiguration()
    }
}
