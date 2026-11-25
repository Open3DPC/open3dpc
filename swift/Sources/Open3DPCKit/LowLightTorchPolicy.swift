// Copyright 2026 Roman Simonov. Licensed under the Apache License, Version 2.0.

import Foundation

/// Says once per session that the scene is too dark to read. It owns no camera and no clock; you feed
/// it brightness samples and light the torch when it answers `true`.
///
/// It never says when to turn the torch off: the torch is what made the scene bright.
public struct LowLightTorchPolicy: Sendable {
    /// `Bv ≤ 0` is roughly `Ev100 ≤ 5`, an unlit room at night. A value from the scale, not calibrated.
    public static let defaultThreshold = 0.0
    /// Below full power, so that a near, glossy object does not turn into a highlight.
    public static let torchLevel: Float = 0.35
    static let sustained: TimeInterval = 1
    static let minimumSamples = 8
    static let codeGrace: TimeInterval = 2

    private let threshold: Double
    private var darkSince: Date?
    private var samples = 0
    private var done = false

    public init(threshold: Double = Self.defaultThreshold) {
        self.threshold = threshold
    }

    /// APEX brightness from the camera's exposure state, for buffers without
    /// `kCGImagePropertyExifBrightnessValue`.
    public static func brightness(aperture: Double, exposureSeconds: Double, iso: Double) -> Double? {
        guard [aperture, exposureSeconds, iso].allSatisfy({ $0.isFinite && $0 > 0 }) else { return nil }
        return log2(aperture * aperture / exposureSeconds) - log2(iso / 100) - 5
    }

    /// - Parameters:
    ///   - codeSeenAt: when a code was last read; a torch on a code that reads does harm.
    ///   - torchIsOn: the person may have lit it already.
    /// - Returns: `true` once, when the torch should be lit.
    public mutating func shouldLight(
        brightness: Double, at now: Date = Date(), codeSeenAt: Date? = nil, torchIsOn: Bool
    ) -> Bool {
        guard brightness.isFinite, brightness <= threshold else {
            darkSince = nil
            samples = 0
            return false
        }
        let since = darkSince ?? now
        darkSince = since
        samples += 1
        guard !done, !torchIsOn, samples >= Self.minimumSamples,
              now.timeIntervalSince(since) >= Self.sustained else { return false }
        if let codeSeenAt, now.timeIntervalSince(codeSeenAt) < Self.codeGrace { return false }
        done = true
        return true
    }
}
