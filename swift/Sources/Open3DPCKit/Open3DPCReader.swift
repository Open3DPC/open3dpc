// Copyright 2026 Roman Simonov. Licensed under the Apache License, Version 2.0.

import CoreGraphics
import CoreImage
import CoreVideo
import Foundation

/// A code found in one frame. Valid by its checksum; confirm it with `Open3DPCStabilizer` before
/// acting on it.
public struct Open3DPCReading: Equatable, Sendable {
    /// The payload bits. Their count is part of the meaning: 9 bits and 14 bits are different things.
    public let payload: [Bool]
    /// Rows × columns the code was printed with, after its rotation was undone.
    public let geometry: Open3DPC.Geometry
    /// Corners of the area the code was read from, slightly outside its frame: TL, TR, BR, BL of the
    /// frame in normalised image coordinates with the origin at the lower left, as Vision uses.
    public let corners: [CGPoint]
    /// The same number for one code followed over consecutive frames.
    public let trackID: UInt64

    /// The payload as `0` and `1`.
    public var bits: String { String(payload.map { $0 ? "1" : "0" }) }
    /// The payload as an unsigned integer, most significant bit first; `nil` over 64 bits or when empty.
    public var value: UInt64? {
        guard (1...64).contains(payload.count) else { return nil }
        return payload.reduce(0) { ($0 << 1) | ($1 ? 1 : 0) }
    }
}

/// Finds Open3DPC codes in camera frames and images.
///
/// Use one reader per camera session, always from the same serial queue: it follows codes between
/// frames. One call can take longer than a frame interval, so drop frames that arrive meanwhile
/// (`alwaysDiscardsLateVideoFrames`).
public final class Open3DPCReader {
    public struct Options: Sendable {
        /// Payload lengths your application understands; `nil` accepts any. Set it: fewer accepted
        /// lengths means fewer false reads.
        public var payloadLengths: Set<Int>?
        /// Shapes your application prints; `nil` accepts any valid one.
        public var geometries: Set<Open3DPC.Geometry>?

        public init(payloadLengths: Set<Int>? = nil, geometries: Set<Open3DPC.Geometry>? = nil) {
            self.payloadLengths = payloadLengths
            self.geometries = geometries
        }
    }

    public let options: Options
    private let decoder = Open3DPCFrameDecoder()
    private lazy var context = CIContext(options: [.cacheIntermediates: false])

    public init(options: Options = .init()) {
        self.options = options
        decoder.accepts = { [options] in Self.accepts($0, options) }
    }

    /// Reads a camera frame.
    ///
    /// - Parameters:
    ///   - pixelBuffer: a bi-planar YUV buffer (`420f` or `420v`). Other formats read as nothing.
    ///   - regionOfInterest: the part to search, normalised, origin at the lower left. Pass the
    ///     viewfinder: it bounds the work and keeps neighbouring codes out.
    public func read(_ pixelBuffer: CVPixelBuffer, regionOfInterest: CGRect? = nil) -> [Open3DPCReading] {
        switch CVPixelBufferGetPixelFormatType(pixelBuffer) {
        case kCVPixelFormatType_420YpCbCr8BiPlanarFullRange, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange: break
        default: return []
        }
        return decoder.analyze(pixelBuffer: pixelBuffer, regionOfInterest: regionOfInterest).compactMap { observation in
            guard let code = observation.physical, accepts(code) else { return nil }
            return Open3DPCReading(
                payload: code.payload, geometry: code.geometry, corners: observation.corners,
                trackID: observation.result.candidateTrackID
            )
        }
    }

    /// Reads a still image.
    public func read(_ image: CGImage) -> [Open3DPCReading] {
        // YUV 4:2:0 needs even dimensions.
        let width = image.width & ~1, height = image.height & ~1
        var buffer: CVPixelBuffer?
        let attributes = [kCVPixelBufferIOSurfacePropertiesKey: [String: Any]()] as CFDictionary
        guard width >= 16, height >= 16, CVPixelBufferCreate(
            nil, width, height, kCVPixelFormatType_420YpCbCr8BiPlanarFullRange, attributes, &buffer
        ) == kCVReturnSuccess, let buffer else { return [] }
        context.render(CIImage(cgImage: image), to: buffer)
        // Each frame is searched one way; a picture gets both.
        let found = read(buffer)
        return found.isEmpty ? read(buffer) : found
    }

    func accepts(_ code: Open3DPC.Validated) -> Bool { Self.accepts(code, options) }

    private static func accepts(_ code: Open3DPC.Validated, _ options: Options) -> Bool {
        (options.payloadLengths?.contains(code.payloadLength) ?? true)
            && (options.geometries?.contains(code.geometry) ?? true)
    }
}

/// Turns per-frame readings into one confirmed code: the same payload on the same track in two
/// frames close together. With several codes in view it confirms none.
///
/// The checksum is short, so one frame is not enough to act on.
public struct Open3DPCStabilizer: Sendable {
    /// Two sightings further apart than this are not the same look at a code.
    public static let consistencyWindow: TimeInterval = 0.45
    /// How long a confirmed code survives frames in which it was not seen.
    public static let retention: TimeInterval = 0.42

    private var pending: Open3DPCReading?
    private var seen = 0
    private var lastSeen: Date?
    private var confirmed: Open3DPCReading?

    public init() {}

    /// Feed every frame's readings, empty ones too. Returns the confirmed code while it is in view.
    public mutating func observe(_ readings: [Open3DPCReading], at date: Date = Date()) -> Open3DPCReading? {
        guard readings.count <= 1 else {
            reset()
            return nil
        }
        if let reading = readings.first {
            if let pending, pending.payload == reading.payload, pending.trackID == reading.trackID,
               let lastSeen, date > lastSeen, date.timeIntervalSince(lastSeen) <= Self.consistencyWindow {
                seen += 1
            } else {
                seen = 1
                confirmed = nil
            }
            pending = reading
            lastSeen = date
            if seen >= 2 { confirmed = reading }
        }
        guard let lastSeen, date.timeIntervalSince(lastSeen) <= Self.retention else {
            reset()
            return nil
        }
        return confirmed
    }

    public mutating func reset() {
        self = .init()
    }
}
