// Copyright 2026 Roman Simonov. Licensed under the Apache License, Version 2.0.

import CoreGraphics
import Foundation

struct Open3DPCVisualResult {
    let sourceFrameID: UInt64
    let candidateTrackID: UInt64
    /// Vision-normalised outer-frame corners, ordered TL, TR, BR, BL.
    let canonicalCorners: [CGPoint]
    let stage: Open3DPCVisualStage
    let geometry: Open3DPC.Geometry?
    let validated: Open3DPC.Validated?
    let metrics: Open3DPCVisualMetrics
    /// The gate that rejected this candidate. Classify by this, not by parsing `detail`.
    let rejection: Open3DPCRejection
    /// Human-readable presentation only, including measured values.
    let detail: String

    init(
        sourceFrameID: UInt64,
        candidateTrackID: UInt64,
        canonicalCorners: [CGPoint],
        stage: Open3DPCVisualStage,
        geometry: Open3DPC.Geometry?,
        validated: Open3DPC.Validated?,
        metrics: Open3DPCVisualMetrics,
        rejection: Open3DPCRejection = .none,
        detail: String
    ) {
        self.sourceFrameID = sourceFrameID
        self.candidateTrackID = candidateTrackID
        self.canonicalCorners = canonicalCorners
        self.stage = stage
        self.geometry = geometry
        self.validated = validated
        self.metrics = metrics
        self.rejection = rejection
        self.detail = detail
    }
}

/// The specific structural gate that rejected a candidate.
///
/// Diagnostics classify by this value, never by matching the human-readable detail string. Prose
/// matching previously left four categories that only a since-deleted sampler could produce, so
/// every rejection the live decoder actually emits fell through to a generic stage label.
enum Open3DPCRejection: String, Equatable, Sendable, CaseIterable {
    case none
    case rectifiedFrameTooSmall
    case frameContrastBelowThreshold
    case polarityRingNotMaterial
    case interiorLacksOppositeMaterial
    case frameThicknessInconsistent
    case modulesNotSquare
    case noUniqueAttachedMarker
    case ambiguousCornerMarkers
    case markerQuietBandMissing
    case moduleQuietBandMissing
    case noProtocolValidGrid
    case markerDisagreesWithScale
    case outerFrameDiscontinuous
    case ambiguousCellConfidence
    case ambiguousGeometry
    case coarseProposalLacksOppositeMaterial
    case noCornerStep
    case noSecondPassRectangle
    case secondPassLacksOppositeMaterial

    /// Short, stable label for the debug ranking. Measured values stay in the detail string.
    var debugLabel: String {
        switch self {
        case .none: "no rejection"
        case .rectifiedFrameTooSmall: "rectified frame too small"
        case .frameContrastBelowThreshold: "frame contrast below threshold"
        case .polarityRingNotMaterial: "frame ring polarity mismatch"
        case .interiorLacksOppositeMaterial: "interior lacks opposite material"
        case .frameThicknessInconsistent: "frame thickness inconsistent"
        case .modulesNotSquare: "modules not square"
        case .noUniqueAttachedMarker: "no unique attached M×M marker"
        case .ambiguousCornerMarkers: "ambiguous corner markers"
        case .markerQuietBandMissing: "marker M/2 band missing"
        case .moduleQuietBandMissing: "module M/2 band missing"
        case .noProtocolValidGrid: "no protocol-valid grid at this scale"
        case .markerDisagreesWithScale: "marker disagrees with frame scale"
        case .outerFrameDiscontinuous: "outer frame discontinuous"
        case .ambiguousCellConfidence: "ambiguous cell confidence"
        case .ambiguousGeometry: "ambiguous geometry hypotheses"
        case .coarseProposalLacksOppositeMaterial: "proposal interior is one colour"
        case .noCornerStep: "no single inward corner step"
        case .noSecondPassRectangle: "no second-pass rectangle"
        case .secondPassLacksOppositeMaterial: "second-pass lacks opposite material"
        }
    }
}

enum Open3DPCVisualStage: Equatable {
    case frame
    case sampling
    case geometry
    case ambiguousCell
    case malformed
    case orientation
    case crc
    case emptyDataRegion
    case validated

    var debugLabel: String {
        switch self {
        case .frame: "frame captured"
        case .sampling: "frame/marker rejected"
        case .geometry: "grid geometry rejected"
        case .ambiguousCell: "ambiguous cell sampling"
        case .malformed: "sampled grid malformed"
        case .orientation: "orientation marker rejected"
        case .crc: "CRC mismatch"
        case .emptyDataRegion: "CRC valid; data region empty"
        case .validated: "valid code"
        }
    }

    var diagnosticPriority: Int {
        switch self {
        case .frame: 0
        case .sampling: 1
        case .geometry: 2
        case .ambiguousCell: 3
        case .malformed: 4
        case .orientation: 5
        case .crc: 6
        case .emptyDataRegion: 7
        case .validated: 9
        }
    }
}

struct Open3DPCVisualMetrics: Equatable {
    struct GeometryHypothesis: Equatable {
        let geometry: Open3DPC.Geometry
        let horizontalModule: Double
        let verticalModule: Double
        let structuralScore: Double
    }

    struct CellConfidence: Equatable {
        let row: Int
        let column: Int
        /// 0 means a 50/50 material/background sample; 1 means unanimous evidence.
        let confidence: Double
    }

    struct SamplingGrid: Equatable {
        let canvasSize: CGSize
        let outerFrame: CGRect
        let geometry: Open3DPC.Geometry
        let horizontalModule: Double
        let verticalModule: Double
    }

    struct CoarsePreflight: Equatable {
        /// `maximum - minimum` over the sampled interior. Recorded even when the early return fires
        /// on it, which is the one number that return used to drop.
        let contrastSpan: Double
        let threshold: Double
        let frameIsLight: Bool
        let interiorOppositeFraction: Double
        let cornerRuns: [Double]

        private var sortedRuns: [Double] { cornerRuns.sorted() }

        var longestRun: Double { sortedRuns.last ?? 0 }
        var secondLongestRun: Double { sortedRuns.count >= 2 ? sortedRuns[sortedRuns.count - 2] : 0 }

        /// How much the longest run beats the second. `.infinity` when the second is zero — one
        /// corner reaching inward and three finding nothing at all is the most unique a step can be,
        /// and reporting it as a division by zero would lose that.
        var uniquenessRatio: Double {
            secondLongestRun > 0 ? longestRun / secondLongestRun : .infinity
        }
    }

    /// The unique attached M×M marker square accepted before lattice enumeration. Its bounds
    /// start at the measured *inner* frame edges, so a cropped outer frame never turns a
    /// 1.5M corner extent into the marker measurement.
    struct AttachedMarker: Equatable {
        let frame: CGRect
        let horizontalModule: Double
        let verticalModule: Double
        let materialScore: Double
    }

    /// Wall time spent inside each stage of one candidate's analysis, in milliseconds.
    ///
    /// `decodeMilliseconds` alone says a frame was slow but not which cost to cut, and the three
    /// stages below have very different fixes: the preflight gates are cheap luma reads, the
    /// second pass is a Vision request, and rectification is a Core Image render plus a raster
    /// read-back **per candidate**. `rectifiedCandidates` is the multiplier on that last one.
    struct StageTimings: Equatable {
        /// Both scale-free luma gates over the coarse quadrilateral.
        let preflightMilliseconds: Double
        /// The wide crop and the second Vision rectangle pass inside it.
        let secondPassMilliseconds: Double
        /// `CIPerspectiveCorrection` and the raster read-back, summed over every candidate rectified.
        let rectifyMilliseconds: Double
        /// Cell sampling and the structural gates, summed over every candidate sampled.
        let sampleMilliseconds: Double
        /// How many second-pass candidates were rectified and sampled.
        let rectifiedCandidates: Int

        static let zero = StageTimings(
            preflightMilliseconds: 0, secondPassMilliseconds: 0, rectifyMilliseconds: 0,
            sampleMilliseconds: 0, rectifiedCandidates: 0
        )
    }

    let roiSize: CGSize
    let coarseProposalCount: Int
    let clusteredTrackCount: Int
    let registrationAttempts: Int
    let geometryHypotheses: [GeometryHypothesis]
    let outerFrameScore: Double?
    let markerScore: Double?
    let quietBandScore: Double?
    /// Fraction of the candidate's inset that is the material opposite to the frame.
    let interiorBackgroundScore: Double?
    /// Independently measured half-module frame thicknesses before grid fitting.
    let horizontalFrameThickness: Double?
    let verticalFrameThickness: Double?
    /// `max(Mx, My) / min(Mx, My)` after perspective rectification; valid modules are square.
    let moduleAspectRatio: Double?
    /// Fraction of the inner-frame-guided M×M orientation square that is marker material.
    let markerCornerScore: Double?
    let attachedMarker: AttachedMarker?
    let cellConfidences: [CellConfidence]
    /// Present once the decoder has committed to a concrete H×W lattice on a rectified raster.
    let samplingGrid: SamplingGrid?
    /// Absent when neither coarse gate ran — a candidate that never reached them.
    let coarsePreflight: CoarsePreflight?
    let decodeMilliseconds: Double
    let stageTimings: StageTimings

    static let empty = Open3DPCVisualMetrics(
        roiSize: .zero,
        coarseProposalCount: 0,
        clusteredTrackCount: 0,
        registrationAttempts: 0,
        geometryHypotheses: [],
        outerFrameScore: nil,
        markerScore: nil,
        quietBandScore: nil,
        interiorBackgroundScore: nil,
        horizontalFrameThickness: nil,
        verticalFrameThickness: nil,
        moduleAspectRatio: nil,
        markerCornerScore: nil,
        attachedMarker: nil,
        cellConfidences: [],
        samplingGrid: nil,
        coarsePreflight: nil,
        decodeMilliseconds: 0,
        stageTimings: .zero
    )
}

/// Deterministic, camera-independent input for visual registration regression tests. `rgba` is
/// a top-down, 8-bit RGBA raster exactly as produced by Core Image rectification.
struct Open3DPCVisualFixture: Equatable {
    let id: String
    let width: Int
    let height: Int
    let rgba: Data
    let expectedStage: Open3DPCVisualStage
    let expectedGeometry: Open3DPC.Geometry?
    let expectedPayload: [Bool]?
}

struct Open3DPCVisualFixtureOutcome: Equatable {
    let id: String
    let stage: Open3DPCVisualStage
    let geometry: Open3DPC.Geometry?
    /// The recovered payload — never the data region, whose terminator and padding stay physical.
    let payload: [Bool]?
    let detail: String
    var sampleMilliseconds: Double = 0

    func matches(_ fixture: Open3DPCVisualFixture) -> Bool {
        stage == fixture.expectedStage
            && geometry == fixture.expectedGeometry
            && payload == fixture.expectedPayload
    }
}
