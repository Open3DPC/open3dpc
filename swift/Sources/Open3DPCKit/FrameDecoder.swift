// Copyright 2026 Roman Simonov. Licensed under the Apache License, Version 2.0.

import CoreVideo
import CoreGraphics
import CoreImage
import Foundation
import Vision


/// Structural gates. A reader uses `.strict`; the rest exist for experiments.
struct Open3DPCValidationGates: Sendable, Equatable {
    var requireConsistentFrameThickness: Bool = true
    var requireSquareModules: Bool = false
    var requireOuterFrameContinuity: Bool = true
    var requireMarkerQuietBand: Bool = true
    var requireModuleQuietBands: Bool = true
    var requireUniqueCornerStep: Bool = true

    static let strict = Self()
}

/// Extracts a profile-independent Open3D Print Code grid from live camera frames. The decoder
/// reports the deepest stage reached for every plausible physical frame; completion policy stays
/// in the scanner so a valid generic code never becomes an application action by itself.
final class Open3DPCFrameDecoder {
    private struct Proposal {
        let topLeft: CGPoint
        let topRight: CGPoint
        let bottomRight: CGPoint
        let bottomLeft: CGPoint

        init(_ rectangle: VNRectangleObservation) {
            topLeft = rectangle.topLeft
            topRight = rectangle.topRight
            bottomRight = rectangle.bottomRight
            bottomLeft = rectangle.bottomLeft
        }

        init(_ corners: [CGPoint]) {
            topLeft = corners[0]
            topRight = corners[1]
            bottomRight = corners[2]
            bottomLeft = corners[3]
        }

        var corners: [CGPoint] { [topLeft, topRight, bottomRight, bottomLeft] }

    }

    typealias Stage = Open3DPCVisualStage

    struct Observation {
        let stage: Stage
        /// Protocol-valid geometry and data, before an optional application-profile decision.
        let physical: Open3DPC.Validated?
        let payload: String?
        /// A unique corner marker and grid have been found, not merely a generic rectangle.
        let hasPhysicalSignature: Bool
        /// Vision-normalized corners (origin at lower-left) of the physical outer frame.
        let corners: [CGPoint]
        /// Compact measurements from the last structurally captured frame, for debug UI only.
        let detail: String
        let result: Open3DPCVisualResult
    }

    /// Two ways to find rectangles. Neither finds everything the other does: on 292 lab captures contours
    /// read 37 codes Vision missed, mostly small ones, and missed 28 that Vision read. Contours cost less
    /// than a Vision request, so a frame takes one search, and a frame that read nothing hands over to the
    /// other: a code that only one of them finds is still read twice in a row.
    enum Search {
        case contours, vision
        var other: Search { self == .contours ? .vision : .contours }
    }
    private(set) var search = Search.contours
    /// Which codes end the hand-over; a reader sets its own options here.
    var accepts: (Open3DPC.Validated) -> Bool = { _ in true }
    private let coarseQuads = ContourQuads.coarse()
    private let secondQuads = ContourQuads.second()
    private static let clusterOverlap: CGFloat = 0.45

    private let context = CIContext(options: [.cacheIntermediates: false])
    private var nextSourceFrameID: UInt64 = 0
    private var nextTrackID: UInt64 = 0
    private var tracks: [PhysicalTrack] = []

    private struct PhysicalTrack {
        let id: UInt64
        var bounds: CGRect
        var lastSourceFrameID: UInt64
    }

    func analyze(
        pixelBuffer: CVPixelBuffer,
        regionOfInterest: CGRect? = nil,
        validationGates: Open3DPCValidationGates = .strict
    ) -> [Observation] {
        nextSourceFrameID &+= 1
        let sourceFrameID = nextSourceFrameID
        let startedAt = CFAbsoluteTimeGetCurrent()
        let unit = CGRect(x: 0, y: 0, width: 1, height: 1)
        let region = (regionOfInterest ?? unit).intersection(unit)
        guard !region.isNull, region.width > 0, region.height > 0 else { return [] }

        let source = CIImage(cvPixelBuffer: pixelBuffer)
        guard CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly) == kCVReturnSuccess else { return [] }
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
        guard CVPixelBufferGetPlaneCount(pixelBuffer) > 0,
              let planeBase = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0) else { return [] }
        let luma = LumaPlane(
            base: UnsafeRawPointer(planeBase),
            width: CVPixelBufferGetWidthOfPlane(pixelBuffer, 0),
            height: CVPixelBufferGetHeightOfPlane(pixelBuffer, 0),
            bytesPerRow: CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
        )
        let roiSize = CGSize(
            width: source.extent.width * (regionOfInterest?.width ?? 1),
            height: source.extent.height * (regionOfInterest?.height ?? 1)
        )
        guard let proposals = search == .vision
            ? visionProposals(in: pixelBuffer, region: region) : contourProposals(in: luma, region: region) else { return [] }
        var raw: [Observation] = []
        for proposal in proposals {
            // A code's outer contour and its inner opening are one code: once it validated, the
            // clustering below would discard the other reading anyway, and it costs a frame.
            if search == .contours, raw.contains(where: {
                $0.physical.map(accepts) == true && overlap(bounds(of: $0.corners), bounds(of: proposal.corners)) >= Self.clusterOverlap
            }) { continue }
            let observation = analyze(
                proposal: proposal,
                source: source,
                luma: luma,
                sourceFrameID: sourceFrameID,
                coarseProposalCount: proposals.count,
                roiSize: roiSize,
                startedAt: startedAt,
                validationGates: validationGates
            )
            if let observation { raw.append(observation) }
        }
        if !raw.contains(where: { $0.physical.map(accepts) == true }) { search = search.other }
        return cluster(raw, sourceFrameID: sourceFrameID)
    }

    private func contourProposals(in luma: LumaPlane, region: CGRect) -> [Proposal]? {
        let width = CGFloat(luma.width), height = CGFloat(luma.height)
        return coarseQuads.proposals(
            luma: luma.base.assumingMemoryBound(to: UInt8.self),
            width: luma.width, height: luma.height, bytesPerRow: luma.bytesPerRow,
            region: CGRect(x: region.minX * width, y: (1 - region.maxY) * height, width: region.width * width, height: region.height * height)
        ).map { quad in Proposal(quad.map { CGPoint(x: ($0.x + 0.5) / width, y: 1 - ($0.y + 0.5) / height) }) }
    }

    private func visionProposals(in pixelBuffer: CVPixelBuffer, region: CGRect) -> [Proposal]? {
        let request = VNDetectRectanglesRequest()
        // Geometry is inferred later. Vision only supplies coarse, profile-independent quads.
        request.minimumAspectRatio = 0.08
        request.maximumAspectRatio = 1.0
        request.minimumSize = 0.045
        // A print page contains many rectangles (browser chrome, QR codes, page edges).
        // Keep searching past those so a qualifying physical frame reaches structural validation.
        request.maximumObservations = 48
        // Vision is only a broad proposal generator. The rectified image verifies a real
        // continuous frame, attached marker and module lattice before it becomes a code frame.
        // This permits an oblique physical tray without accepting a generic rectangle.
        request.quadratureTolerance = 35
        request.regionOfInterest = region
        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, options: [:])
        guard (try? handler.perform([request])) != nil, let results = request.results else { return nil }
        return results.map { Proposal($0) }
    }

    /// Vision often returns nested versions of the same printed frame. Keep only one physical
    /// candidate per overlap cluster before any result reaches confirmation, while retaining
    /// genuinely distinct complete codes as separate candidates.
    private func cluster(_ observations: [Observation], sourceFrameID: UInt64) -> [Observation] {
        var clusters: [[Observation]] = []
        for observation in observations {
            if let index = clusters.firstIndex(where: { cluster in
                cluster.contains { overlap(observation.corners, $0.corners) >= Self.clusterOverlap || isSameCode(observation, $0) }
            }) {
                clusters[index].append(observation)
            } else {
                clusters.append([observation])
            }
        }
        return clusters.compactMap { cluster in
            guard let selected = cluster.max(by: { lhs, rhs in
                if lhs.stage.diagnosticPriority != rhs.stage.diagnosticPriority {
                    return lhs.stage.diagnosticPriority < rhs.stage.diagnosticPriority
                }
                return (lhs.result.metrics.outerFrameScore ?? 0) < (rhs.result.metrics.outerFrameScore ?? 0)
            }) else { return nil }
            return assigningTrack(to: selected, sourceFrameID: sourceFrameID, clusteredTrackCount: clusters.count)
        }
    }

    /// One code read from its frame and again from a wider rectangle around it. Their boxes overlap too
    /// little to cluster, and two readings in a frame confirm nothing.
    private func isSameCode(_ lhs: Observation, _ rhs: Observation) -> Bool {
        guard let a = lhs.physical, let b = rhs.physical, a.payload == b.payload, a.geometry == b.geometry else { return false }
        let boxA = bounds(of: lhs.corners), boxB = bounds(of: rhs.corners)
        return boxA.contains(CGPoint(x: boxB.midX, y: boxB.midY)) || boxB.contains(CGPoint(x: boxA.midX, y: boxA.midY))
    }

    private func assigningTrack(
        to observation: Observation,
        sourceFrameID: UInt64,
        clusteredTrackCount: Int
    ) -> Observation {
        let bounds = bounds(of: observation.corners)
        tracks.removeAll { sourceFrameID > $0.lastSourceFrameID + 12 }
        let trackID: UInt64
        if let index = tracks.firstIndex(where: { overlap(bounds, $0.bounds) >= 0.35 }) {
            trackID = tracks[index].id
            tracks[index].bounds = bounds
            tracks[index].lastSourceFrameID = sourceFrameID
        } else {
            nextTrackID &+= 1
            trackID = nextTrackID
            tracks.append(.init(id: trackID, bounds: bounds, lastSourceFrameID: sourceFrameID))
        }
        let old = observation.result.metrics
        let metrics = Open3DPCVisualMetrics(
            roiSize: old.roiSize,
            coarseProposalCount: old.coarseProposalCount,
            clusteredTrackCount: clusteredTrackCount,
            registrationAttempts: old.registrationAttempts,
            geometryHypotheses: old.geometryHypotheses,
            outerFrameScore: old.outerFrameScore,
            markerScore: old.markerScore,
            quietBandScore: old.quietBandScore,
            interiorBackgroundScore: old.interiorBackgroundScore,
            horizontalFrameThickness: old.horizontalFrameThickness,
            verticalFrameThickness: old.verticalFrameThickness,
            moduleAspectRatio: old.moduleAspectRatio,
            markerCornerScore: old.markerCornerScore,
            attachedMarker: old.attachedMarker,
            cellConfidences: old.cellConfidences,
            samplingGrid: old.samplingGrid,
            coarsePreflight: old.coarsePreflight,
            decodeMilliseconds: old.decodeMilliseconds,
            stageTimings: old.stageTimings
        )
        let result = Open3DPCVisualResult(
            sourceFrameID: observation.result.sourceFrameID,
            candidateTrackID: trackID,
            canonicalCorners: observation.result.canonicalCorners,
            stage: observation.result.stage,
            geometry: observation.result.geometry,
            validated: observation.result.validated,
            metrics: metrics,
            rejection: observation.result.rejection,
            detail: observation.result.detail
        )
        return Observation(
            stage: observation.stage,
            physical: observation.physical,
            payload: observation.payload,
            hasPhysicalSignature: observation.hasPhysicalSignature,
            corners: observation.corners,
            detail: observation.detail,
            result: result
        )
    }

    private func bounds(of corners: [CGPoint]) -> CGRect {
        guard let first = corners.first else { return .null }
        return corners.dropFirst().reduce(CGRect(origin: first, size: .zero)) { partial, point in
            partial.union(CGRect(origin: point, size: .zero))
        }
    }

    private func overlap(_ lhs: [CGPoint], _ rhs: [CGPoint]) -> CGFloat {
        overlap(bounds(of: lhs), bounds(of: rhs))
    }

    private func overlap(_ lhs: CGRect, _ rhs: CGRect) -> CGFloat {
        let intersection = lhs.intersection(rhs)
        guard !intersection.isNull else { return 0 }
        let union = lhs.width * lhs.height + rhs.width * rhs.height - intersection.width * intersection.height
        return union > 0 ? intersection.width * intersection.height / union : 0
    }

    private func analyze(
        proposal: Proposal,
        source: CIImage,
        luma: LumaPlane,
        sourceFrameID: UInt64,
        coarseProposalCount: Int,
        roiSize: CGSize,
        startedAt: CFAbsoluteTime,
        validationGates: Open3DPCValidationGates
    ) -> Observation? {
        let corners = proposal.corners
        let extent = source.extent
        func point(_ normalized: CGPoint) -> CGPoint {
            CGPoint(x: extent.minX + normalized.x * extent.width, y: extent.minY + normalized.y * extent.height)
        }
        let topLeft = point(proposal.topLeft)
        let topRight = point(proposal.topRight)
        let bottomLeft = point(proposal.bottomLeft)
        let bottomRight = point(proposal.bottomRight)

        // The first Vision quadrilateral is deliberately not rectified. It can be a skewed
        // page edge or a partial contour; its sole job is to define a wide, unwarped crop in
        // which a second detector can find the actual outer frame.
        let coarseCorners = [topLeft, topRight, bottomRight, bottomLeft]

        // Stage timings are accumulated as the candidate walks the pipeline and reported on every
        // exit, including the early ones — a proposal rejected cheaply is exactly the case that
        // proves the cheap gates are worth what they cost.
        var preflightMilliseconds = 0.0
        var preflightRecord: Open3DPCVisualMetrics.CoarsePreflight?
        var secondPassMilliseconds = 0.0
        var rectifyMilliseconds = 0.0
        var sampleMilliseconds = 0.0
        var rectifiedCandidates = 0
        func elapsed(since mark: CFAbsoluteTime) -> Double { (CFAbsoluteTimeGetCurrent() - mark) * 1_000 }
        var timings: Open3DPCVisualMetrics.StageTimings {
            .init(
                preflightMilliseconds: preflightMilliseconds,
                secondPassMilliseconds: secondPassMilliseconds,
                rectifyMilliseconds: rectifyMilliseconds,
                sampleMilliseconds: sampleMilliseconds,
                rectifiedCandidates: rectifiedCandidates
            )
        }

        // Two cheap, scale-free checks before anything expensive runs. Everything below this point
        // costs a second Vision pass and perspective renders per candidate, and it used to run for
        // every proposal Vision returned — which is where the frame budget went.
        let preflightMark = CFAbsoluteTimeGetCurrent()
        let coarsePreflight = oppositeInteriorMaterial(
            in: luma,
            topLeft: topLeft, topRight: topRight, bottomRight: bottomRight, bottomLeft: bottomLeft
        )
        guard coarsePreflight.hasOppositeMaterial else {
            preflightMilliseconds = elapsed(since: preflightMark)
            // No runs: the corner walk never ran. The span and the fraction that rejected it do.
            preflightRecord = Open3DPCVisualMetrics.CoarsePreflight(
                contrastSpan: coarsePreflight.contrastSpan,
                threshold: coarsePreflight.threshold,
                frameIsLight: coarsePreflight.frameIsLight,
                interiorOppositeFraction: coarsePreflight.oppositeMaterialScore,
                cornerRuns: []
            )
            return observation(
                stage: .frame, physical: nil, corners: corners,
                sourceFrameID: sourceFrameID, coarseProposalCount: coarseProposalCount,
                roiSize: roiSize, startedAt: startedAt, timings: timings,
                preflight: preflightRecord,
                rejection: .coarseProposalLacksOppositeMaterial,
                detail: "proposal interior is a single colour"
            )
        }
        let cornerStep = hasSingleCornerStep(
            in: luma, corners: coarseCorners,
            threshold: coarsePreflight.threshold, frameIsLight: coarsePreflight.frameIsLight
        )
        preflightRecord = Open3DPCVisualMetrics.CoarsePreflight(
            contrastSpan: coarsePreflight.contrastSpan,
            threshold: coarsePreflight.threshold,
            frameIsLight: coarsePreflight.frameIsLight,
            interiorOppositeFraction: coarsePreflight.oppositeMaterialScore,
            cornerRuns: cornerStep.runs
        )
        preflightMilliseconds = elapsed(since: preflightMark)
        guard cornerStep.passes || !validationGates.requireUniqueCornerStep else {
            return observation(
                stage: .frame, physical: nil, corners: corners,
                sourceFrameID: sourceFrameID, coarseProposalCount: coarseProposalCount,
                roiSize: roiSize, startedAt: startedAt, timings: timings,
                preflight: preflightRecord,
                rejection: .noCornerStep,
                detail: "no unique inward corner step"
            )
        }

        let secondPassMark = CFAbsoluteTimeGetCurrent()
        guard let wideCrop = wideCrop(in: source, around: coarseCorners) else { return nil }
        let secondary = search == .vision ? secondaryQuadrilaterals(in: wideCrop) : contourQuadrilaterals(in: wideCrop.extent, of: luma)
        secondPassMilliseconds = elapsed(since: secondPassMark)
        guard !secondary.isEmpty else {
            return observation(
                stage: .frame, physical: nil, corners: corners,
                sourceFrameID: sourceFrameID, coarseProposalCount: coarseProposalCount,
                roiSize: roiSize, startedAt: startedAt, timings: timings,
                preflight: preflightRecord,
                rejection: .noSecondPassRectangle,
                detail: "wide crop has no second-pass rectangle"
            )
        }

        // Only a second-pass quadrilateral is allowed to define a perspective transform.
        // Therefore a bad coarse contour cannot turn an otherwise useful crop into a warped
        // raster before the physical frame checks even begin.
        let registered = secondary.compactMap { candidate -> (corners: [CGPoint], sampling: SamplingResult)? in
            let preflight = oppositeInteriorMaterial(
                in: luma,
                topLeft: candidate[0], topRight: candidate[1], bottomRight: candidate[2], bottomLeft: candidate[3]
            )
            guard preflight.hasOppositeMaterial else { return nil }
            // The interior check belongs to the code, so it runs on the contour Vision proposed.
            // The rectification does not: it is aimed deliberately wide. See `expanded`.
            let registration = Self.expanded(candidate)
            let rectifyMark = CFAbsoluteTimeGetCurrent()
            let corrected = source.applyingFilter("CIPerspectiveCorrection", parameters: [
                "inputTopLeft": CIVector(cgPoint: registration[0]),
                "inputTopRight": CIVector(cgPoint: registration[1]),
                "inputBottomLeft": CIVector(cgPoint: registration[3]),
                "inputBottomRight": CIVector(cgPoint: registration[2]),
            ])
            guard let image = imageData(from: corrected) else {
                rectifyMilliseconds += elapsed(since: rectifyMark)
                return nil
            }
            rectifyMilliseconds += elapsed(since: rectifyMark)
            rectifiedCandidates += 1
            let sampleMark = CFAbsoluteTimeGetCurrent()
            let sampling = sampledMatricesOnEitherAxis(from: image, validationGates: validationGates)
            sampleMilliseconds += elapsed(since: sampleMark)
            return (registration, sampling)
        }
        guard let selected = registered.max(by: { samplingPriority($0.sampling) < samplingPriority($1.sampling) }) else {
            return observation(
                stage: .frame, physical: nil, corners: corners,
                sourceFrameID: sourceFrameID, coarseProposalCount: coarseProposalCount,
                roiSize: roiSize,
                startedAt: startedAt, timings: timings,
                preflight: preflightRecord,
                rejection: .secondPassLacksOppositeMaterial,
                detail: "second-pass rectangle lacks opposite material"
            )
        }
        let selectedCorners = selected.corners.map {
            CGPoint(x: ($0.x - extent.minX) / extent.width, y: ($0.y - extent.minY) / extent.height)
        }
        let sampling = selected.sampling
        guard !sampling.matrices.isEmpty else {
            return observation(
                stage: sampling.reason == .ambiguousCellConfidence ? .ambiguousCell : .sampling,
                physical: nil, corners: selectedCorners,
                sourceFrameID: sourceFrameID, coarseProposalCount: coarseProposalCount,
                roiSize: roiSize,
                startedAt: startedAt, diagnostics: sampling.diagnostics,
                physicalSignature: sampling.hasPhysicalSignature, timings: timings,
                preflight: preflightRecord,
                rejection: sampling.reason, detail: sampling.rejection
            )
        }

        var deepestFailure: Stage = .geometry
        var failureDetail = sampling.matrices[0].detail
        for sampled in sampling.matrices {
            let physical: Open3DPC.Validated
            switch Open3DPC.validate(sampled.matrix) {
            case .success(let validated):
                physical = validated
            case .failure(.invalidOrientation):
                if Stage.orientation.diagnosticPriority > deepestFailure.diagnosticPriority {
                    deepestFailure = .orientation
                    failureDetail = sampled.detail
                }
                continue
            case .failure(.crcMismatch):
                if Stage.crc.diagnosticPriority > deepestFailure.diagnosticPriority {
                    deepestFailure = .crc
                    failureDetail = sampled.detail
                }
                continue
            case .failure(.emptyDataRegion):
                if Stage.emptyDataRegion.diagnosticPriority > deepestFailure.diagnosticPriority {
                    deepestFailure = .emptyDataRegion
                    failureDetail = sampled.detail
                }
                continue
            case .failure(.invalidGeometry):
                failureDetail = sampled.detail
                continue
            case .failure(.malformedMatrix):
                if Stage.malformed.diagnosticPriority > deepestFailure.diagnosticPriority {
                    deepestFailure = .malformed
                    failureDetail = sampled.detail
                }
                continue
            }
            return observation(
                stage: .validated, physical: physical, corners: selectedCorners,
                sourceFrameID: sourceFrameID, coarseProposalCount: coarseProposalCount,
                roiSize: roiSize,
                startedAt: startedAt, sampled: sampled, diagnostics: sampling.diagnostics,
                timings: timings,
                preflight: preflightRecord,
                detail: sampled.detail
            )
        }
        return observation(
            stage: deepestFailure, physical: nil, corners: selectedCorners,
            sourceFrameID: sourceFrameID, coarseProposalCount: coarseProposalCount,
            roiSize: roiSize,
            startedAt: startedAt, sampled: sampling.matrices.first, diagnostics: sampling.diagnostics,
            timings: timings,
            preflight: preflightRecord,
            detail: failureDetail
        )
    }

    /// The measurements that establish a physical code before any payload bit is sampled.
    private struct StructuralDiagnostics {
        let interiorBackgroundScore: Double
        let horizontalFrameThickness: Double?
        let verticalFrameThickness: Double?
        let moduleAspectRatio: Double?
        let markerCornerScore: Double?
        let attachedMarker: Open3DPCVisualMetrics.AttachedMarker?
    }

    /// Read-only view of the camera buffer's luminance plane.
    ///
    /// Every pre-rectification check samples through this instead of rendering a crop through Core
    /// Image. Those renders were ~130 CGImage round-trips per frame and accounted for essentially
    /// all of the measured 328–753 ms decode latency.
    private struct LumaPlane {
        let base: UnsafeRawPointer
        let width: Int
        let height: Int
        let bytesPerRow: Int

        /// `point` is in Core Image space for the full frame: origin bottom-left.
        func brightness(atImagePoint point: CGPoint) -> Double {
            let x = min(max(Int(point.x.rounded()), 0), width - 1)
            let y = min(max(Int((CGFloat(height) - point.y).rounded()), 0), height - 1)
            return Double(base.load(fromByteOffset: y * bytesPerRow + x, as: UInt8.self))
        }
    }

    private struct OppositeMaterialPreflight {
        let oppositeMaterialScore: Double
        let hasOppositeMaterial: Bool
        var threshold: Double = 0
        var frameIsLight: Bool = false
        /// `maximum - minimum` over the sampled interior. Populated on **both** returns, including
        /// the early one that fails on it: a crop rejected for being flat used to report only that
        /// it was flat, never how flat, so the 28 in that test was as unarguable as the 1.6 below.
        var contrastSpan: Double = 0
    }

    /// Vision supplies only a rectangle proposal. This method verifies the physical construction:
    /// a half-module continuous outer frame, one frame-attached 1.5M corner block, then a grid
    /// whose scale is derived from those measurements. CRC never influences registration.
    private struct SampledMatrix {
        let matrix: Open3DPC.Matrix
        let rows: Int
        let columns: Int
        let module: Double
        let edgeMaterialFraction: Double
        let horizontalModule: Double
        let verticalModule: Double
        let markerScore: Double
        let quietBandScore: Double
        /// The least confidently classified cell in this hypothesis. A hypothesis that has invented
        /// columns has to classify background as payload, so this is where it gives itself away —
        /// the structural terms cannot, since surplus background is structurally perfect.
        let lowestCellConfidence: Double
        let diagnostics: StructuralDiagnostics
        /// How far this lattice's module is from the measured one, on the worse axis.
        var scaleError: Double {
            guard let marker = diagnostics.attachedMarker else { return .infinity }
            return max(abs(horizontalModule / marker.horizontalModule - 1), abs(verticalModule / marker.verticalModule - 1))
        }
        let cellConfidences: [Open3DPCVisualMetrics.CellConfidence]
        let structuralScore: Double
        let samplingGrid: Open3DPCVisualMetrics.SamplingGrid?

        var detail: String {
            "grid \(rows)×\(columns) · Mx/My \(String(format: "%.1f", horizontalModule))/\(String(format: "%.1f", verticalModule)) px · frame \(Int((edgeMaterialFraction * 100).rounded()))%"
        }
    }

    private struct SamplingResult {
        let matrices: [SampledMatrix]
        let rejection: String
        let reason: Open3DPCRejection
        let diagnostics: StructuralDiagnostics?
        let hasPhysicalSignature: Bool

        init(
            matrices: [SampledMatrix],
            rejection: String,
            reason: Open3DPCRejection = .none,
            diagnostics: StructuralDiagnostics? = nil,
            hasPhysicalSignature: Bool = false
        ) {
            self.matrices = matrices
            self.rejection = rejection
            self.reason = reason
            self.diagnostics = diagnostics
            self.hasPhysicalSignature = hasPhysicalSignature
        }
    }

    /// The corrected canvas and the exact outer-frame crop within it.  All physical checks and
    /// module samples for a `SampledMatrix` are made in this coordinate system, never back on
    /// the camera raster.
    private struct SamplingSpace {
        let canvasSize: CGSize
        let outerFrame: CGRect
    }

    private struct RefinedOuterFrame {
        let raster: Raster
        let frame: CGRect
    }

    private func observation(
        stage: Stage,
        physical: Open3DPC.Validated?,
        corners: [CGPoint],
        sourceFrameID: UInt64,
        coarseProposalCount: Int,
        roiSize: CGSize,
        startedAt: CFAbsoluteTime,
        sampled: SampledMatrix? = nil,
        diagnostics: StructuralDiagnostics? = nil,
        physicalSignature: Bool? = nil,
        timings: Open3DPCVisualMetrics.StageTimings = .zero,
        preflight: Open3DPCVisualMetrics.CoarsePreflight? = nil,
        rejection: Open3DPCRejection = .none,
        detail: String
    ) -> Observation {
        let elapsed = (CFAbsoluteTimeGetCurrent() - startedAt) * 1_000
        let geometry = sampled.map { Open3DPC.Geometry(height: $0.rows, width: $0.columns) }
        let structural = diagnostics ?? sampled?.diagnostics
        let metrics = Open3DPCVisualMetrics(
            roiSize: roiSize,
            coarseProposalCount: coarseProposalCount,
            clusteredTrackCount: coarseProposalCount,
            registrationAttempts: 1,
            geometryHypotheses: geometry.map {
                [.init(
                    geometry: $0,
                    horizontalModule: sampled?.horizontalModule ?? 0,
                    verticalModule: sampled?.verticalModule ?? 0,
                    structuralScore: sampled?.structuralScore ?? 0
                )]
            } ?? [],
            outerFrameScore: sampled?.edgeMaterialFraction,
            markerScore: sampled?.markerScore,
            quietBandScore: sampled?.quietBandScore,
            interiorBackgroundScore: structural?.interiorBackgroundScore,
            horizontalFrameThickness: structural?.horizontalFrameThickness,
            verticalFrameThickness: structural?.verticalFrameThickness,
            moduleAspectRatio: structural?.moduleAspectRatio,
            markerCornerScore: structural?.markerCornerScore,
            attachedMarker: structural?.attachedMarker,
            cellConfidences: sampled?.cellConfidences ?? [],
            samplingGrid: sampled?.samplingGrid,
            coarsePreflight: preflight,
            decodeMilliseconds: elapsed,
            stageTimings: timings
        )
        let result = Open3DPCVisualResult(
            sourceFrameID: sourceFrameID,
            candidateTrackID: sourceFrameID,
            canonicalCorners: corners,
            stage: stage,
            geometry: physical?.geometry ?? geometry,
            validated: physical,
            metrics: metrics,
            rejection: rejection,
            detail: detail
        )
        return Observation(
            stage: stage,
            physical: physical,
            payload: physical?.payloadBitString,
            hasPhysicalSignature: physicalSignature ?? (sampled != nil),
            corners: corners,
            detail: detail,
            result: result
        )
    }

    /// Returns an axis-aligned crop around the coarse proposal. This intentionally preserves the
    /// source perspective: a coarse quadrilateral is not reliable enough to be a homography.
    private func wideCrop(in source: CIImage, around corners: [CGPoint]) -> CIImage? {
        guard corners.count == 4 else { return nil }
        let bounds = corners.dropFirst().reduce(CGRect(origin: corners[0], size: .zero)) {
            $0.union(CGRect(origin: $1, size: .zero))
        }
        let crop = bounds
            .insetBy(dx: -bounds.width * 0.26, dy: -bounds.height * 0.26)
            .intersection(source.extent)
            .integral
        guard crop.width >= 16, crop.height >= 16 else { return nil }
        return source.cropped(to: crop)
    }

    private func contourQuadrilaterals(in crop: CGRect, of luma: LumaPlane) -> [[CGPoint]] {
        let height = CGFloat(luma.height)
        return secondQuads.proposals(
            luma: luma.base.assumingMemoryBound(to: UInt8.self),
            width: luma.width, height: luma.height, bytesPerRow: luma.bytesPerRow,
            region: CGRect(x: crop.minX, y: height - crop.maxY, width: crop.width, height: crop.height)
        ).map { $0.map { CGPoint(x: $0.x + 0.5, y: height - $0.y - 0.5) } }
    }

    /// Finds the physical-frame candidates in the wide but still unwarped source crop. The
    /// points are expressed in the original CI image coordinate system and are the only points
    /// permitted to drive the subsequent perspective correction.
    private func secondaryQuadrilaterals(in wideCrop: CIImage) -> [[CGPoint]] {
        let request = VNDetectRectanglesRequest()
        request.minimumAspectRatio = 0.08
        request.maximumAspectRatio = 1
        request.minimumSize = 0.06
        request.maximumObservations = 5
        request.quadratureTolerance = 18
        let handler = VNImageRequestHandler(ciImage: wideCrop, options: [:])
        guard (try? handler.perform([request])) != nil,
              let rectangles = request.results else { return [] }
        let extent = wideCrop.extent
        func point(_ normalized: CGPoint) -> CGPoint {
            CGPoint(x: extent.minX + normalized.x * extent.width, y: extent.minY + normalized.y * extent.height)
        }
        return rectangles.map {
            [point($0.topLeft), point($0.topRight), point($0.bottomRight), point($0.bottomLeft)]
        }
    }

    /// When the cells cannot settle a tie, the measured module may: the lattice whose module is within
    /// `scaleAgreement` of it, if the next best is at least `scaleSeparation` further off. The module
    /// is measured on the orientation corner (frame plus feature, 1.5M), so it owes nothing to the
    /// lattice. A dark row or column from edge to edge has no cell borders to count and needs this.
    static let scaleAgreement = 0.08
    static let scaleSeparation = 0.04

    /// How far the leading hypothesis must beat the runner-up on its least confident cell to settle a
    /// structural tie. See docs/reader-pipeline.md, stage 10.
    static let cellConfidenceTieBreak = 0.10

    /// How far outside the detected contour the rectification is aimed, as a fraction of the
    /// quadrilateral's shortest side. A crop slightly too tight has already cut the outer frame and
    /// nothing later can restore it; one a whole module too loose costs nothing, because
    /// `refinedOuterFrame` finds the real ring inside the margin. See docs/reader-pipeline.md, stage 5.
    static let registrationMargin: CGFloat = 0.08

    /// Offsets every edge of `quad` outward by `registrationMargin`, preserving its shape.
    ///
    /// Each edge is moved along its own outward normal and the new corners are the intersections
    /// of adjacent offset edges, so the result is the original quadrilateral with a uniform border
    /// — not a scaled copy, which would add margin unevenly on a foreshortened code.
    static func expanded(_ quad: [CGPoint], fraction: CGFloat = registrationMargin) -> [CGPoint] {
        guard quad.count == 4 else { return quad }
        func length(_ a: CGPoint, _ b: CGPoint) -> CGFloat {
            ((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)).squareRoot()
        }
        let sides = (0..<4).map { length(quad[$0], quad[($0 + 1) % 4]) }
        guard let shortest = sides.min(), shortest > 1 else { return quad }
        let margin = shortest * fraction
        let centre = CGPoint(
            x: quad.reduce(0) { $0 + $1.x } / 4,
            y: quad.reduce(0) { $0 + $1.y } / 4
        )

        // Edge `i` runs from `quad[i]` to `quad[i + 1]`, offset along whichever normal points away
        // from the centroid. Deriving the sign from the centroid rather than from a winding order
        // keeps this correct in both Core Image's bottom-up space and a top-down raster.
        let offsets: [(origin: CGPoint, direction: CGPoint)] = (0..<4).map { index in
            let start = quad[index]
            let end = quad[(index + 1) % 4]
            let direction = CGPoint(x: end.x - start.x, y: end.y - start.y)
            let scale = sides[index] > 0 ? sides[index] : 1
            var normal = CGPoint(x: -direction.y / scale, y: direction.x / scale)
            let midpoint = CGPoint(x: (start.x + end.x) / 2, y: (start.y + end.y) / 2)
            if (midpoint.x - centre.x) * normal.x + (midpoint.y - centre.y) * normal.y < 0 {
                normal = CGPoint(x: -normal.x, y: -normal.y)
            }
            return (CGPoint(x: start.x + normal.x * margin, y: start.y + normal.y * margin), direction)
        }

        return (0..<4).map { index in
            let incoming = offsets[(index + 3) % 4]
            let outgoing = offsets[index]
            let denominator = incoming.direction.x * outgoing.direction.y - incoming.direction.y * outgoing.direction.x
            // Adjacent edges of a real code are never parallel, but a degenerate proposal can make
            // them so; falling back to the un-offset corner is better than an intersection at
            // infinity dragging the crop off the frame.
            guard abs(denominator) > 1e-6 else { return quad[index] }
            let deltaX = outgoing.origin.x - incoming.origin.x
            let deltaY = outgoing.origin.y - incoming.origin.y
            let travel = (deltaX * outgoing.direction.y - deltaY * outgoing.direction.x) / denominator
            return CGPoint(
                x: incoming.origin.x + incoming.direction.x * travel,
                y: incoming.origin.y + incoming.direction.y * travel
            )
        }
    }

    private func sampledMatricesOnEitherAxis(
        from image: Raster,
        validationGates: Open3DPCValidationGates
    ) -> SamplingResult {
        let first = sampledMatrices(from: image, validationGates: validationGates)
        guard first.matrices.isEmpty, image.axis != .chromatic else { return first }
        let chromatic = sampledMatrices(from: image.on(.chromatic), validationGates: validationGates)
        // Keeping the deeper attempt matters even when neither decoded: the recorded rejection
        // should describe the better-founded measurement, not whichever ran last.
        return samplingPriority(chromatic) > samplingPriority(first) ? chromatic : first
    }

    private func samplingPriority(_ result: SamplingResult) -> Double {
        let physical = result.hasPhysicalSignature ? 10_000.0 : 0
        let decoded = result.matrices.isEmpty ? 0.0 : 1_000.0
        let measurements = result.diagnostics?.horizontalFrameThickness != nil ? 100.0 : 0.0
        return physical + decoded + measurements + (result.diagnostics?.markerCornerScore ?? 0)
    }

    /// Enumerates bounded protocol-valid lattices from the outer-frame raster. This has no
    /// application profile or target-size input: structural evidence chooses the geometry before
    /// the CRC core sees a matrix.
    /// Vision's quadrilateral is only a neighbourhood.  First locate a four-sided material ring
    /// *inside* that neighbourhood, then run the physical checks against the refined bounds.  A
    /// raw Vision rectangle is retained only as a fallback diagnostic; it is never treated as an
    /// outer-frame measurement by itself.
    private func sampledMatrices(
        from image: Raster,
        validationGates: Open3DPCValidationGates = .strict
    ) -> SamplingResult {
        let rawSpace = SamplingSpace(
            canvasSize: CGSize(width: CGFloat(image.width), height: CGFloat(image.height)),
            outerFrame: CGRect(x: 0, y: 0, width: CGFloat(image.width), height: CGFloat(image.height))
        )
        let raw = sampledMatricesCore(from: image, samplingSpace: rawSpace, validationGates: validationGates)
        guard let refined = refinedOuterFrame(in: image) else { return raw }
        let registered = sampledMatricesCore(
            from: refined.raster,
            samplingSpace: SamplingSpace(canvasSize: rawSpace.canvasSize, outerFrame: refined.frame),
            validationGates: validationGates
        )
        if registered.hasPhysicalSignature || !raw.hasPhysicalSignature,
           registered.diagnostics?.horizontalFrameThickness != nil {
            return registered
        }
        return raw
    }

    /// Finds the material ring independently of the proposal boundary.  It is intentionally
    /// whole-edge based: isolated modules, glyph strokes, and a filled rectangle cannot score a
    /// four-sided ring with an opposite-colour interior.
    private func refinedOuterFrame(in image: Raster) -> RefinedOuterFrame? {
        let width = Double(image.width)
        let height = Double(image.height)
        let shortestSide = min(width, height)
        guard shortestSide >= 24 else {
            return nil
        }
        let probeSpan = max(1, shortestSide / 220)
        let samples = 15
        let field = ThresholdField(image: image, span: probeSpan)
        guard field.contrast >= 28 else {
            return nil
        }

        struct AxisLine {
            let position: Double
            let score: Double
        }
        struct Ring {
            let left: AxisLine
            let right: AxisLine
            let top: AxisLine
            let bottom: AxisLine
            let materialIsLight: Bool
            let oppositeInteriorScore: Double

            var score: Double {
                (left.score + right.score + top.score + bottom.score) / 4 + oppositeInteriorScore * 0.30
            }
        }

        /// Fraction of samples that are material along one line.
        ///
        /// `crossFrom`/`crossTo` bound the span the line is scored over. A frame line only runs
        /// between the other two sides of its own ring, so scoring it across the whole raster
        /// charges it for everything outside — which is what kept an inner ring from ever
        /// outscoring the crop boundary.
        func lineScore(
            at position: Double, vertical: Bool, materialIsLight: Bool,
            crossFrom: Double = 0, crossTo: Double = 1
        ) -> Double {
            let span = max(0.05, crossTo - crossFrom)
            let hits = (1...samples).filter { index in
                let fraction = crossFrom + span * Double(index) / Double(samples + 1)
                let x = vertical ? position : width * fraction
                let y = vertical ? height * fraction : position
                let brightness = image.brightness(x: x, y: y, span: probeSpan)
                let threshold = field(x, y)
                return materialIsLight ? brightness > threshold : brightness < threshold
            }.count
            return Double(hits) / Double(samples)
        }
        /// Every plausible frame line in a search band, ordered outermost first.
        ///
        /// The old search kept only the strongest line, and a uniform crop boundary scores a
        /// perfect 1.00 for whichever polarity it happens to match. When Vision proposes the card
        /// a code is printed on rather than the code, that boundary wins every time and the real
        /// frame a few dozen pixels inside is never considered. Enumerating lets the ring search
        /// step inward.
        ///
        /// Each returned line is the centre of a contiguous run of qualifying positions — the band
        /// centre, which is what the outer-frame rectangle below assumes. The outermost rows and
        /// columns take part: excluding them truncated the plateau on the far edges and pulled the
        /// computed centre inward by about a pixel, a fifth of the band when the module is small.
        func candidateLines(
            from lower: Double, to upper: Double, vertical: Bool, materialIsLight: Bool,
            crossFrom: Double = 0, crossTo: Double = 1, outermostFirst: Bool
        ) -> [AxisLine] {
            let limit = vertical ? width : height
            let start = max(0, Int((limit * lower).rounded(.up)))
            let end = min(Int(limit) - 1, Int((limit * upper).rounded(.down)))
            guard start <= end else { return [] }
            let scored = (start...end).map { position in
                AxisLine(
                    position: Double(position),
                    score: lineScore(
                        at: Double(position), vertical: vertical, materialIsLight: materialIsLight,
                        crossFrom: crossFrom, crossTo: crossTo
                    )
                )
            }
            var bands: [AxisLine] = []
            var run: [AxisLine] = []
            func close() {
                guard let first = run.first, let last = run.last else { return }
                bands.append(AxisLine(
                    position: (first.position + last.position) / 2,
                    score: run.map(\.score).max() ?? 0
                ))
                run = []
            }
            for line in scored {
                if line.score >= 0.60 { run.append(line) } else { close() }
            }
            close()
            let ordered = outermostFirst ? bands : bands.reversed().map { $0 }
            return Array(ordered.prefix(3))
        }
        func median(_ values: [Double]) -> Double? {
            guard !values.isEmpty else { return nil }
            let sorted = values.sorted()
            return sorted[sorted.count / 2]
        }
        func materialRun(
            at line: AxisLine, vertical: Bool, materialIsLight: Bool,
            crossFrom: Double = 0, crossTo: Double = 1
        ) -> Double? {
            let limit = vertical ? width : height
            let crossLimit = vertical ? height : width
            // Four per half, so a half still holds up after losing a probe to a speck or a torn
            // edge, and every fraction stays clear of the corners the way the old five did.
            let nearFractions = [0.20, 0.28, 0.36, 0.44]
            let farFractions = [0.56, 0.64, 0.72, 0.80]
            let crossSpan = max(0.05, crossTo - crossFrom)
            func runs(over fractions: [Double]) -> [Double] {
                fractions.compactMap { fraction -> Double? in
                    let cross = crossLimit * (crossFrom + crossSpan * fraction)
                    // Point samples: this measures the band's width, and a neighbourhood average
                    // stops the run about a pixel early on each side. That is a fifth of the band
                    // once the module drops near the decodable floor.
                    let isMaterial: (Double) -> Bool = { position in
                        let x = vertical ? position : cross
                        let y = vertical ? cross : position
                        let brightness = image.brightness(x: x, y: y, span: 0, minimumHalf: 0)
                        let threshold = field(x, y)
                        return materialIsLight ? brightness > threshold : brightness < threshold
                    }
                    guard isMaterial(line.position) else { return nil }
                    var low = line.position
                    while low > 0, isMaterial(low - 1) { low -= 1 }
                    var high = line.position
                    while high < limit - 1, isMaterial(high + 1) { high += 1 }
                    return high - low + 1
                }
            }
            switch (median(runs(over: nearFractions)), median(runs(over: farFractions))) {
            case let (near?, far?): return min(near, far)
            case let (near, far): return near ?? far
            }
        }
        func oppositeInteriorScore(for ring: Ring) -> Double {
            let x0 = ring.left.position
            let x1 = ring.right.position
            let y0 = ring.top.position
            let y1 = ring.bottom.position
            guard x1 - x0 >= 12, y1 - y0 >= 12 else { return 0 }
            let count = (2...8).flatMap { row in
                (2...8).map { column -> Bool in
                    let x = x0 + (x1 - x0) * Double(column) / 10
                    let y = y0 + (y1 - y0) * Double(row) / 10
                    let brightness = image.brightness(x: x, y: y, span: probeSpan)
                    let threshold = field(x, y)
                    return ring.materialIsLight ? brightness < threshold : brightness > threshold
                }
            }.filter(\.self).count
            return Double(count) / 49
        }

        /// Exactly one corner of a real code carries the orientation marker, whose material runs
        /// inward about three times as far as a plain corner's frame line. It is the same ratio
        /// `hasSingleCornerStep` uses on the coarse quadrilateral, applied here to tell a code's
        /// frame from the card it is printed on — a card has four identical corners.
        func hasCornerStep(_ ring: Ring) -> Bool {
            let x0 = ring.left.position, x1 = ring.right.position
            let y0 = ring.top.position, y1 = ring.bottom.position
            // Normalized to the shorter side for the reason spelled out on `hasSingleCornerStep`:
            // a parametric diagonal walks past the marker on an elongated ring, which is how the
            // *correct* ring came to be the one this gate threw away.
            let ringWidth = x1 - x0, ringHeight = y1 - y0
            let shortestSide = min(ringWidth, ringHeight)
            guard shortestSide > 0 else { return false }
            let uScale = shortestSide / ringWidth
            let vScale = shortestSide / ringHeight
            let steps = 24
            let limit = 0.45
            let runs = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)].map { origin -> Double in
                var lastMaterial = 0.0
                var backgroundRun = 0
                for index in 1...steps {
                    let distance = limit * Double(index) / Double(steps)
                    let u = origin.0 == 0 ? distance * uScale : 1 - distance * uScale
                    let v = origin.1 == 0 ? distance * vScale : 1 - distance * vScale
                    let x = x0 + (x1 - x0) * u
                    let y = y0 + (y1 - y0) * v
                    let brightness = image.brightness(x: x, y: y, span: probeSpan)
                    let threshold = field(x, y)
                    if ring.materialIsLight ? brightness > threshold : brightness < threshold {
                        lastMaterial = distance
                        backgroundRun = 0
                    } else {
                        backgroundRun += 1
                        if backgroundRun >= 2 { break }
                    }
                }
                return lastMaterial
            }.sorted()
            return runs[3] >= 0.03 && runs[3] >= runs[2] * 1.6
        }

        // Rings are enumerated innermost-first and the first structurally sound one wins. The
        // outermost is usually the crop boundary; when that boundary is the code the inner
        // candidates simply fail and it is reached anyway.
        var candidateRings: [Ring] = []
        for materialIsLight in [false, true] {
            let lefts = candidateLines(from: 0, to: 0.35, vertical: true, materialIsLight: materialIsLight, outermostFirst: true)
            let rights = candidateLines(from: 0.65, to: 1, vertical: true, materialIsLight: materialIsLight, outermostFirst: false)
            let tops = candidateLines(from: 0, to: 0.35, vertical: false, materialIsLight: materialIsLight, outermostFirst: true)
            let bottoms = candidateLines(from: 0.65, to: 1, vertical: false, materialIsLight: materialIsLight, outermostFirst: false)
            for left in lefts {
                for right in rights where right.position - left.position >= 16 {
                    for top in tops {
                        for bottom in bottoms where bottom.position - top.position >= 16 {
                            // Re-score each side across its own ring rather than the whole raster.
                            let crossX = (left.position / width, right.position / width)
                            let crossY = (top.position / height, bottom.position / height)
                            let scored = Ring(
                                left: AxisLine(position: left.position, score: lineScore(
                                    at: left.position, vertical: true, materialIsLight: materialIsLight,
                                    crossFrom: crossY.0, crossTo: crossY.1
                                )),
                                right: AxisLine(position: right.position, score: lineScore(
                                    at: right.position, vertical: true, materialIsLight: materialIsLight,
                                    crossFrom: crossY.0, crossTo: crossY.1
                                )),
                                top: AxisLine(position: top.position, score: lineScore(
                                    at: top.position, vertical: false, materialIsLight: materialIsLight,
                                    crossFrom: crossX.0, crossTo: crossX.1
                                )),
                                bottom: AxisLine(position: bottom.position, score: lineScore(
                                    at: bottom.position, vertical: false, materialIsLight: materialIsLight,
                                    crossFrom: crossX.0, crossTo: crossX.1
                                )),
                                materialIsLight: materialIsLight,
                                oppositeInteriorScore: 0
                            )
                            // Cheapest test first: the four line scores are already in hand, while
                            // the interior costs 49 averaged probes and the corner step ~96 more.
                            let minimumLine = [scored.left.score, scored.right.score, scored.top.score, scored.bottom.score]
                                .min() ?? 0
                            guard minimumLine >= 0.67 else { continue }
                            let interior = oppositeInteriorScore(for: scored)
                            let ring = Ring(
                                left: scored.left, right: scored.right, top: scored.top, bottom: scored.bottom,
                                materialIsLight: materialIsLight, oppositeInteriorScore: interior
                            )
                            guard ring.score >= 0.80, interior >= 0.12 else { continue }
                            guard hasCornerStep(ring) else { continue }
                            candidateRings.append(ring)
                        }
                    }
                }
            }
        }
        // Innermost first: on a card crop the code's frame is inside the boundary, and a ring that
        // encloses another sound ring cannot be the outer frame of the code the inner one is.
        let rings = candidateRings.sorted {
            let lhs = ($0.right.position - $0.left.position) * ($0.bottom.position - $0.top.position)
            let rhs = ($1.right.position - $1.left.position) * ($1.bottom.position - $1.top.position)
            return lhs < rhs
        }
        if rings.isEmpty {
        }
        for ring in rings {
            if let refined = refinedFrame(for: ring) { return refined }
        }
        return nil

        /// The structural half of the search: everything that needs the ring's measured frame
        /// thickness. Separated so the enumeration above can try the next candidate instead of
        /// giving up on the first ring whose thickness does not hold together.
        func refinedFrame(for ring: Ring) -> RefinedOuterFrame? {
        let crossX = (ring.left.position / width, ring.right.position / width)
        let crossY = (ring.top.position / height, ring.bottom.position / height)
        guard let leftThickness = materialRun(
                  at: ring.left, vertical: true, materialIsLight: ring.materialIsLight,
                  crossFrom: crossY.0, crossTo: crossY.1
              ),
              let rightThickness = materialRun(
                  at: ring.right, vertical: true, materialIsLight: ring.materialIsLight,
                  crossFrom: crossY.0, crossTo: crossY.1
              ),
              let topThickness = materialRun(
                  at: ring.top, vertical: false, materialIsLight: ring.materialIsLight,
                  crossFrom: crossX.0, crossTo: crossX.1
              ),
              let bottomThickness = materialRun(
                  at: ring.bottom, vertical: false, materialIsLight: ring.materialIsLight,
                  crossFrom: crossX.0, crossTo: crossX.1
              )
        else {
            return nil
        }

        let outerWidth = ring.right.position - ring.left.position + (leftThickness + rightThickness) / 2
        let outerHeight = ring.bottom.position - ring.top.position + (topThickness + bottomThickness) / 2
        // Worth knowing when this gate next looks suspicious: the frame is `M/2` and the narrowest
        // raster the format allows is `3 M` across — a matrix one cell wide — so a legal frame
        // reaches 16.7% of the short side and this bound sits only 1.3 points above it. Raising it
        // to 0.23 was tried and reverted: it admitted a ring the 0.18 bound had been rejecting, and
        // that ring decoded a *wrong* payload under `corners 0.25 M + sigma 0.20 M`. Whatever buys
        // headroom here has to come from measuring the band better, not from widening the bound.
        let maximumThinFrame = min(outerWidth, outerHeight) * 0.18
        let maximumThicknessDisparity = 0.55
        guard max(leftThickness, rightThickness, topThickness, bottomThickness) <= maximumThinFrame,
              abs(leftThickness - rightThickness) / max(leftThickness, rightThickness) <= maximumThicknessDisparity,
              abs(topThickness - bottomThickness) / max(topThickness, bottomThickness) <= maximumThicknessDisparity
        else {
            return nil
        }
        // A row of data cells can score as a side of the ring: it is straight, and it is material over
        // most of the span. Only a frame side reaches its neighbours. Between a data row and the frame
        // the format keeps an M/2 gap, so look there, at both ends of every side.
        let sideEnds: [(x: Double, y: Double)] = [
            (ring.left.position + leftThickness, ring.top.position), (ring.right.position - rightThickness, ring.top.position),
            (ring.left.position + leftThickness, ring.bottom.position), (ring.right.position - rightThickness, ring.bottom.position),
            (ring.left.position, ring.top.position + topThickness), (ring.left.position, ring.bottom.position - bottomThickness),
            (ring.right.position, ring.top.position + topThickness), (ring.right.position, ring.bottom.position - bottomThickness),
        ]
        let joinedEnds = sideEnds.filter {
            let brightness = image.brightness(x: $0.x, y: $0.y, span: probeSpan)
            return ring.materialIsLight ? brightness > field($0.x, $0.y) : brightness < field($0.x, $0.y)
        }.count
        guard joinedEnds >= 7 else { return nil }
        // A real ring changes to its opposite material immediately inside every straight edge.
        // Sampling at 40% of the measured line thickness past the inner contour stays inside the
        // required M/2 quiet band while avoiding the orientation corner and ordinary modules.
        let safeFractions = [0.22, 0.36, 0.50, 0.64, 0.78]
        func isMaterial(_ x: Double, _ y: Double) -> Bool {
            let brightness = image.brightness(x: x, y: y, span: probeSpan)
            return ring.materialIsLight ? brightness > field(x, y) : brightness < field(x, y)
        }
        let innerBandBackgrounds = safeFractions.flatMap { fraction -> [Bool] in
            let x = ring.left.position + (ring.right.position - ring.left.position) * fraction
            let y = ring.top.position + (ring.bottom.position - ring.top.position) * fraction
            return [
                !isMaterial(ring.left.position + leftThickness * 0.90, y),
                !isMaterial(ring.right.position - rightThickness * 0.90, y),
                !isMaterial(x, ring.top.position + topThickness * 0.90),
                !isMaterial(x, ring.bottom.position - bottomThickness * 0.90),
            ]
        }
        let innerBandScore = Double(innerBandBackgrounds.filter(\.self).count) / Double(innerBandBackgrounds.count)
        guard innerBandScore >= 0.65 else {
            return nil
        }
        let frame = CGRect(
            x: ring.left.position - leftThickness / 2,
            y: ring.top.position - topThickness / 2,
            width: outerWidth,
            height: outerHeight
        ).intersection(CGRect(x: 0, y: 0, width: width, height: height)).integral
        guard frame.width >= 16, frame.height >= 16,
              frame.width < width * 0.98 || frame.height < height * 0.98 else {
            return nil
        }
        guard let raster = image.cropped(to: frame) else {
            return nil
        }
        return .init(raster: raster, frame: frame)
        }
    }

    private func sampledMatricesCore(
        from image: Raster,
        samplingSpace: SamplingSpace,
        validationGates: Open3DPCValidationGates
    ) -> SamplingResult {
        let width = Double(image.width)
        let height = Double(image.height)
        let shortestSide = min(width, height)
        guard shortestSide >= 16 else {
            return .init(matrices: [], rejection: "rectified frame too small", reason: .rectifiedFrameTooSmall)
        }

        let field = ThresholdField(image: image, span: max(1, shortestSide / 120))
        guard field.contrast >= 28 else {
            return .init(matrices: [], rejection: "frame contrast below threshold", reason: .frameContrastBelowThreshold)
        }

        struct Corner {
            let id: Int
            let xDirection: Double
            let yDirection: Double
        }
        let corners = [
            Corner(id: 0, xDirection: 1, yDirection: 1),
            Corner(id: 1, xDirection: -1, yDirection: 1),
            Corner(id: 2, xDirection: -1, yDirection: -1),
            Corner(id: 3, xDirection: 1, yDirection: -1),
        ]
        func median(_ values: [Double]) -> Double? {
            guard !values.isEmpty else { return nil }
            let sorted = values.sorted()
            return sorted[sorted.count / 2]
        }

        var candidates: [SampledMatrix] = []
        var rejection = "candidate interior lacks opposite material"
        var rejectionReason = Open3DPCRejection.interiorLacksOppositeMaterial
        var rejectionPriority = 0
        var deepestDiagnostics: StructuralDiagnostics?
        var physicalSignatureSeen = false
        func recordRejection(_ detail: String, _ reason: Open3DPCRejection, priority: Int) {
            guard priority >= rejectionPriority else { return }
            rejectionPriority = priority
            rejection = detail
            rejectionReason = reason
        }

        for materialIsLight in [false, true] {
            func isMaterial(_ brightness: Double, at x: Double, _ y: Double) -> Bool {
                materialIsLight ? brightness > field(x, y) : brightness < field(x, y)
            }

            func materialFraction(centerX: Double, centerY: Double, xRadius: Double, yRadius: Double, span: Double) -> Double {
                let offsets = [-0.55, -0.28, 0, 0.28, 0.55]
                let hits = offsets.flatMap { xOffset in
                    offsets.map { yOffset -> Bool in
                        let x = centerX + xOffset * xRadius
                        let y = centerY + yOffset * yRadius
                        return isMaterial(image.brightness(x: x, y: y, span: span), at: x, y)
                    }
                }.filter(\.self).count
                return Double(hits) / 25
            }

            let interiorMaterial = materialFraction(
                centerX: width * 0.5, centerY: height * 0.5,
                xRadius: width * 0.38, yRadius: height * 0.38,
                span: max(1, shortestSide / 150)
            )
            let interiorBackground = 1 - interiorMaterial
            var diagnostics = StructuralDiagnostics(
                interiorBackgroundScore: interiorBackground,
                horizontalFrameThickness: nil,
                verticalFrameThickness: nil,
                moduleAspectRatio: nil,
                markerCornerScore: nil,
                attachedMarker: nil
            )

            // Polarity is a property of the outer frame: the ring is material for exactly one of
            // the two assignments. Sample well inside the frame band and away from the corners, so
            // neither the orientation marker nor a rectification edge decides this.
            // Several insets, best wins. Rectification never lands the crop exactly on the frame, so
            // a single inset would judge polarity from whichever side the crop happened to miss.
            // Every inset here stays well within a half-module band, so none can reach a data cell.
            let ringProbe = max(1, shortestSide / 150)
            let ringMaterialFraction = [0.02, 0.05, 0.08].map { depth -> Double in
                let inset = max(1, shortestSide * depth)
                let samples = (1...9).flatMap { index -> [(x: Double, y: Double)] in
                    let fraction = Double(index) / 10
                    return [
                        (width * fraction, inset),
                        (width * fraction, height - inset),
                        (inset, height * fraction),
                        (width - inset, height * fraction),
                    ]
                }
                let hits = samples.filter {
                    isMaterial(image.brightness(x: $0.x, y: $0.y, span: ringProbe), at: $0.x, $0.y)
                }.count
                return Double(hits) / Double(samples.count)
            }.max() ?? 0
            guard ringMaterialFraction >= 0.70 else {
                deepestDiagnostics = diagnostics
                recordRejection("outer frame ring is not this polarity's material", .polarityRingNotMaterial, priority: 1)
                continue
            }
            // A code always carries at least its orientation marker inside the ring, so a candidate
            // with a wholly empty interior is not one.
            guard interiorMaterial >= 0.025 else {
                deepestDiagnostics = diagnostics
                recordRejection("candidate interior lacks opposite material", .interiorLacksOppositeMaterial, priority: 1)
                continue
            }

            /// Locates the frame-to-background transition along one inward ray to sub-pixel
            /// precision. Point samples, not a neighbourhood average: a box filter moves the
            /// apparent edge outward, and because the caller doubles this into `M`, that error
            /// arrives at the lattice twice over.
            func frameEdgeTransition(
                startX: Double, startY: Double, deltaX: Double, deltaY: Double, limit: Double
            ) -> Double? {
                func point(_ distance: Double) -> (x: Double, y: Double) {
                    (startX + deltaX * distance, startY + deltaY * distance)
                }
                func sample(_ distance: Double) -> Double {
                    let probe = point(distance)
                    return image.brightness(x: probe.x, y: probe.y, span: 0, minimumHalf: 0)
                }
                func material(_ distance: Double) -> Bool {
                    let probe = point(distance)
                    return isMaterial(sample(distance), at: probe.x, probe.y)
                }
                func threshold(_ distance: Double) -> Double {
                    let probe = point(distance)
                    return field(probe.x, probe.y)
                }
                // Walk at a resolution-proportional step to bracket the transition, then refine
                // only inside that bracket. A fixed fine step here would make every ray's cost grow
                // with the candidate's pixel size, and this runs for six rays on each of four edges,
                // for both polarities, on every registered candidate in every video frame.
                let coarseStep = max(0.5, shortestSide / 240)
                var entry = coarseStep * 0.5
                while entry <= limit, !material(entry) { entry += coarseStep }
                guard entry <= limit else { return nil }
                // Discount only the background actually skipped. `entry` also carries the half-step
                // offset of the very first probe, which is not a gap and must not shorten the band.
                let skipped = entry - coarseStep * 0.5
                var lastMaterial = entry
                var distance = entry + coarseStep
                var bracketEnd: Double?
                while distance <= limit {
                    if !material(distance) { bracketEnd = distance; break }
                    lastMaterial = distance
                    distance += coarseStep
                }
                guard let bracketEnd else { return nil }

                // Refine to sub-pixel: step through the bracket, then interpolate the crossing.
                let fineStep = 0.5
                var previous = sample(lastMaterial)
                var fine = lastMaterial + fineStep
                while fine < bracketEnd {
                    let current = sample(fine)
                    if !material(fine) {
                        let span = current - previous
                        let crossing = abs(span) > 0.0001 ? (threshold(fine) - previous) / span : 0.5
                        return fine - fineStep + min(max(crossing, 0), 1) * fineStep - skipped
                    }
                    previous = current
                    fine += fineStep
                }
                let span = sample(bracketEnd) - previous
                let crossing = abs(span) > 0.0001 ? (threshold(bracketEnd) - previous) / span : 0.5
                return max(fine - fineStep, lastMaterial) + min(max(crossing, 0), 1) * fineStep - skipped
            }

            let nearEdgeFractions = [0.25, 0.35, 0.45]
            let farEdgeFractions = [0.55, 0.65, 0.75]
            func edgeThickness(startX: Double, startY: Double, deltaX: Double, deltaY: Double) -> Double? {
                let alongVerticalEdge = deltaX != 0
                let limit = (alongVerticalEdge ? width : height) * 0.22
                func transitions(over fractions: [Double]) -> [Double] {
                    fractions.compactMap { fraction -> Double? in
                        frameEdgeTransition(
                            startX: alongVerticalEdge ? startX : width * fraction,
                            startY: alongVerticalEdge ? height * fraction : startY,
                            deltaX: deltaX, deltaY: deltaY, limit: limit
                        )
                    }
                }
                let near = transitions(over: nearEdgeFractions)
                let far = transitions(over: farEdgeFractions)
                guard near.count + far.count >= 3 else { return nil }
                switch (median(near), median(far)) {
                case let (near?, far?): return min(near, far)
                case let (near, far): return near ?? far
                }
            }
            // Every ray starts on an outermost pixel *centre*. Starting the opposite pair at
            // `width`/`height` put them a pixel beyond the last centre, so the two sides of the
            // same frame disagreed by about a pixel and the parity gate rejected correct codes.
            guard let leftThickness = edgeThickness(startX: 0, startY: 0, deltaX: 1, deltaY: 0),
                  let rightThickness = edgeThickness(startX: width - 1, startY: 0, deltaX: -1, deltaY: 0),
                  let topThickness = edgeThickness(startX: 0, startY: 0, deltaX: 0, deltaY: 1),
                  let bottomThickness = edgeThickness(startX: 0, startY: height - 1, deltaX: 0, deltaY: -1)
            else {
                deepestDiagnostics = diagnostics
                recordRejection("outer frame thickness is inconsistent", .frameThicknessInconsistent, priority: 2)
                continue
            }
            // Opposing edges measure the same quantity, so combine them. The previous `median` of a
            // two-element array returned the larger, which compounded the outward bias above.
            let horizontalThickness = (leftThickness + rightThickness) / 2
            let verticalThickness = (topThickness + bottomThickness) / 2
            guard horizontalThickness > 0.5, verticalThickness > 0.5,
                  horizontalThickness <= width * 0.2, verticalThickness <= height * 0.2 else {
                deepestDiagnostics = diagnostics
                recordRejection("outer frame thickness is inconsistent", .frameThicknessInconsistent, priority: 2)
                continue
            }
            let frameThicknessIsConsistent =
                abs(leftThickness - rightThickness) / horizontalThickness <= 0.25
                && abs(topThickness - bottomThickness) / verticalThickness <= 0.25
            guard !validationGates.requireConsistentFrameThickness || frameThicknessIsConsistent else {
                deepestDiagnostics = diagnostics
                recordRejection("outer frame thickness is inconsistent", .frameThicknessInconsistent, priority: 2)
                continue
            }
            diagnostics = StructuralDiagnostics(
                interiorBackgroundScore: interiorBackground,
                horizontalFrameThickness: horizontalThickness,
                verticalFrameThickness: verticalThickness,
                moduleAspectRatio: nil,
                markerCornerScore: nil,
                attachedMarker: nil
            )
            var measuredMx = horizontalThickness * 2
            var measuredMy = verticalThickness * 2
            let squareModuleAspectLimit = 1.12
            // How far a hypothesis module may sit from the measured one.
            let moduleAgreementTolerance = 0.20
            let measuredModuleAspectRatio = max(measuredMx, measuredMy) / min(measuredMx, measuredMy)
            diagnostics = StructuralDiagnostics(
                interiorBackgroundScore: interiorBackground,
                horizontalFrameThickness: horizontalThickness,
                verticalFrameThickness: verticalThickness,
                moduleAspectRatio: measuredModuleAspectRatio,
                markerCornerScore: nil,
                attachedMarker: nil
            )
            guard !validationGates.requireSquareModules || measuredModuleAspectRatio <= squareModuleAspectLimit else {
                deepestDiagnostics = diagnostics
                recordRejection(
                    "rectified M is not square (Mx/My \(String(format: "%.2f", measuredModuleAspectRatio)))",
                    .modulesNotSquare,
                    priority: 3
                )
                continue
            }

            func cornerMaterialRun(_ corner: Corner, alongX: Bool, cross: Double) -> Double {
                let step = max(0.5, shortestSide / 240)
                let limit = (alongX ? width : height) * 0.6
                var distance = 0.0
                var lastMaterial = 0.0
                var backgroundRun = 0
                while distance <= limit {
                    let along = (alongX ? corner.xDirection : corner.yDirection) > 0
                        ? distance
                        : (alongX ? width : height) - distance
                    let x = alongX ? along : cross
                    let y = alongX ? cross : along
                    let brightness = image.brightness(x: x, y: y, span: 0, minimumHalf: 0)
                    if isMaterial(brightness, at: x, y) {
                        lastMaterial = distance
                        backgroundRun = 0
                    } else {
                        backgroundRun += 1
                        if backgroundRun >= 2 { break }
                    }
                    distance += step
                }
                return lastMaterial
            }
            // Probe one nominal module in from each edge: past the frame band, still inside the
            // block. The block is large enough that a sizeable error in the seed still lands there.
            let blockRuns = corners.map { corner -> (x: Double, y: Double) in
                let crossY = corner.yDirection > 0 ? measuredMy : height - measuredMy
                let crossX = corner.xDirection > 0 ? measuredMx : width - measuredMx
                return (cornerMaterialRun(corner, alongX: true, cross: crossY),
                        cornerMaterialRun(corner, alongX: false, cross: crossX))
            }
            if let best = blockRuns.enumerated().max(by: { min($0.element.x, $0.element.y) < min($1.element.x, $1.element.y) }) {
                let others = blockRuns.enumerated().filter { $0.offset != best.offset }
                let medianOther = others.map { min($0.element.x, $0.element.y) }.sorted()[1]
                let blockMx = best.element.x / 1.5
                let blockMy = best.element.y / 1.5
                if min(best.element.x, best.element.y) >= medianOther * 1.8,
                   blockMx / measuredMx > 0.55, blockMx / measuredMx < 1.9,
                   blockMy / measuredMy > 0.55, blockMy / measuredMy < 1.9 {
                    // Combine both estimates, weighted by precision rather than averaged evenly.
                    // Edge localisation carries roughly the same absolute error either way, but it
                    // reaches M differently: the line gives M = 2t, so 2σ; the block gives
                    // M = b/1.5, so σ/1.5. Inverse-variance weights are then 2.25 : 0.25 — nine to
                    // one for the block. An even average would discard most of its advantage.
                    let blockWeight = 0.9
                    measuredMx = blockWeight * blockMx + (1 - blockWeight) * measuredMx
                    measuredMy = blockWeight * blockMy + (1 - blockWeight) * measuredMy
                }
            }
            let sampleSpan = min(measuredMx, measuredMy) * 0.12

            func point(_ corner: Corner, xInset: Double, yInset: Double) -> (Double, Double) {
                (
                    corner.xDirection > 0 ? xInset : width - xInset,
                    corner.yDirection > 0 ? yInset : height - yInset
                )
            }
            /// Measure the marker itself, not the combined frame-and-marker 1.5M corner.
            /// The square begins at the *inner* frame guides, which remain meaningful even if
            /// perspective correction clipped or softened an outer frame edge.
            func innerMarkerFrame(
                for corner: Corner,
                horizontalModule: Double,
                verticalModule: Double,
                imageWidth: Double,
                imageHeight: Double,
                horizontalFrameThickness: Double,
                verticalFrameThickness: Double
            ) -> CGRect {
                CGRect(
                    x: corner.xDirection > 0
                        ? horizontalFrameThickness
                        : imageWidth - horizontalFrameThickness - horizontalModule,
                    y: corner.yDirection > 0
                        ? verticalFrameThickness
                        : imageHeight - verticalFrameThickness - verticalModule,
                    width: horizontalModule,
                    height: verticalModule
                )
            }
            func attachedMarker(
                for corner: Corner,
                horizontalModule: Double,
                verticalModule: Double,
                score: Double,
                imageWidth: Double,
                imageHeight: Double,
                samplingSpace: SamplingSpace
            ) -> Open3DPCVisualMetrics.AttachedMarker {
                let local = innerMarkerFrame(
                    for: corner,
                    horizontalModule: horizontalModule,
                    verticalModule: verticalModule,
                    imageWidth: imageWidth,
                    imageHeight: imageHeight,
                    horizontalFrameThickness: horizontalThickness,
                    verticalFrameThickness: verticalThickness
                )
                let scaleX = samplingSpace.outerFrame.width / CGFloat(imageWidth)
                let scaleY = samplingSpace.outerFrame.height / CGFloat(imageHeight)
                return .init(
                    frame: CGRect(
                        x: samplingSpace.outerFrame.minX + local.minX * scaleX,
                        y: samplingSpace.outerFrame.minY + local.minY * scaleY,
                        width: local.width * scaleX,
                        height: local.height * scaleY
                    ),
                    horizontalModule: horizontalModule * Double(scaleX),
                    verticalModule: verticalModule * Double(scaleY),
                    materialScore: score
                )
            }
            func cornerBlockScore(_ corner: Corner, horizontalModule: Double, verticalModule: Double) -> Double {
                let marker = innerMarkerFrame(
                    for: corner,
                    horizontalModule: horizontalModule,
                    verticalModule: verticalModule,
                    imageWidth: width,
                    imageHeight: height,
                    horizontalFrameThickness: horizontalThickness,
                    verticalFrameThickness: verticalThickness
                )
                return materialFraction(
                    centerX: marker.midX,
                    centerY: marker.midY,
                    xRadius: horizontalModule * 0.34,
                    yRadius: verticalModule * 0.34,
                    span: sampleSpan
                )
            }
            let measuredMarkerCandidates = corners.filter {
                cornerBlockScore($0, horizontalModule: measuredMx, verticalModule: measuredMy) >= 0.88
            }
            guard measuredMarkerCandidates.count == 1, let measuredMarker = measuredMarkerCandidates.first else {
                deepestDiagnostics = diagnostics
                recordRejection(
                    measuredMarkerCandidates.isEmpty
                        ? "no unique frame-attached M×M marker from inner frame guides"
                        : "ambiguous frame-attached corner markers",
                    measuredMarkerCandidates.isEmpty ? .noUniqueAttachedMarker : .ambiguousCornerMarkers,
                    priority: 3
                )
                continue
            }
            let measuredMarkerScore = cornerBlockScore(
                measuredMarker, horizontalModule: measuredMx, verticalModule: measuredMy
            )
            diagnostics = StructuralDiagnostics(
                interiorBackgroundScore: interiorBackground,
                horizontalFrameThickness: horizontalThickness,
                verticalFrameThickness: verticalThickness,
                moduleAspectRatio: measuredModuleAspectRatio,
                markerCornerScore: measuredMarkerScore,
                attachedMarker: attachedMarker(
                    for: measuredMarker,
                    horizontalModule: measuredMx,
                    verticalModule: measuredMy,
                    score: measuredMarkerScore,
                    imageWidth: width,
                    imageHeight: height,
                    samplingSpace: samplingSpace
                )
            )
            deepestDiagnostics = diagnostics
            let markerQuietPoints: [(Double, Double)] = [
                point(measuredMarker, xInset: 1.75 * measuredMx, yInset: measuredMy),
                point(measuredMarker, xInset: measuredMx, yInset: 1.75 * measuredMy),
                point(measuredMarker, xInset: 1.75 * measuredMx, yInset: 1.75 * measuredMy),
            ]
            let measuredMarkerQuietBandIsClear = markerQuietPoints.allSatisfy {
                !isMaterial(image.brightness(x: $0.0, y: $0.1, span: sampleSpan), at: $0.0, $0.1)
            }
            if !measuredMarkerQuietBandIsClear { deepestDiagnostics = diagnostics }

            let estimatedRows = Int((height / measuredMy).rounded()) - 2
            let estimatedColumns = Int((width / measuredMx).rounded()) - 2
            let geometries = (-1...1).flatMap { rowOffset in
                (-1...1).compactMap { columnOffset -> Open3DPC.Geometry? in
                    let geometry = Open3DPC.Geometry(
                        height: estimatedRows + rowOffset,
                        width: estimatedColumns + columnOffset
                    )
                    let horizontalModule = width / Double(geometry.width + 2)
                    let verticalModule = height / Double(geometry.height + 2)
                    // The lattice is measured in image orientation, which for a quarter-turned code
                    // is the transpose of its normalized geometry. Filtering on `isValid` here
                    // discarded every hypothesis for a portrait code before rotation normalization
                    // could run.
                    guard geometry.isValidInSomeOrientation,
                          min(horizontalModule, verticalModule) >= 2.5,
                          abs(horizontalModule / measuredMx - 1) <= moduleAgreementTolerance,
                          abs(verticalModule / measuredMy - 1) <= moduleAgreementTolerance else {
                        return nil
                    }
                    return geometry
                }
            }
            guard !geometries.isEmpty else {
                deepestDiagnostics = diagnostics
                recordRejection("frame scale does not fit a protocol-valid grid", .noProtocolValidGrid, priority: 5)
                continue
            }

            for geometry in geometries {
                let rows = geometry.height
                let columns = geometry.width
                let horizontalModule = width / Double(columns + 2)
                let verticalModule = height / Double(rows + 2)
                let moduleAspectRatio = max(horizontalModule, verticalModule) / min(horizontalModule, verticalModule)
                guard !validationGates.requireSquareModules || moduleAspectRatio <= squareModuleAspectLimit else {
                    recordRejection(
                        "grid modules are not square (Mx/My \(String(format: "%.2f", moduleAspectRatio)))",
                        .modulesNotSquare,
                        priority: 5
                    )
                    continue
                }
                let markerCandidates = corners.filter {
                    cornerBlockScore($0, horizontalModule: horizontalModule, verticalModule: verticalModule) >= 0.88
                }
                guard markerCandidates.count == 1,
                      let marker = markerCandidates.first,
                      marker.id == measuredMarker.id else {
                    recordRejection("corner marker does not agree with measured frame scale", .markerDisagreesWithScale, priority: 5)
                    continue
                }
                let markerScore = cornerBlockScore(marker, horizontalModule: horizontalModule, verticalModule: verticalModule)
                let markerRow = marker.yDirection > 0 ? 0 : rows - 1
                let markerColumn = marker.xDirection > 0 ? 0 : columns - 1
                func point(_ corner: Corner, xInset: Double, yInset: Double) -> (Double, Double) {
                    (
                        corner.xDirection > 0 ? xInset : width - xInset,
                        corner.yDirection > 0 ? yInset : height - yInset
                    )
                }

                var frameHits = 0
                var frameTotal = 0
                for index in 1...18 {
                    let x = width * Double(index) / 19
                    let y = height * Double(index) / 19
                    let points = [
                        (x, verticalModule * 0.25),
                        (x, height - verticalModule * 0.25),
                        (horizontalModule * 0.25, y),
                        (width - horizontalModule * 0.25, y),
                    ]
                    for (x, y) in points {
                        if isMaterial(image.brightness(x: x, y: y, span: sampleSpan), at: x, y) { frameHits += 1 }
                        frameTotal += 1
                    }
                }
                let frameScore = Double(frameHits) / Double(frameTotal)
                guard !validationGates.requireOuterFrameContinuity || frameScore >= 0.76 else {
                    recordRejection("outer frame continuity \(Int((frameScore * 100).rounded()))%", .outerFrameDiscontinuous, priority: 2)
                    continue
                }
                physicalSignatureSeen = true

                let gridMarkerQuietPoints: [(Double, Double)] = [
                    point(marker, xInset: 1.75 * horizontalModule, yInset: verticalModule),
                    point(marker, xInset: horizontalModule, yInset: 1.75 * verticalModule),
                    point(marker, xInset: 1.75 * horizontalModule, yInset: 1.75 * verticalModule),
                ]
                // The three immediate M/2 samples are geometric evidence, not a tolerance
                // bucket. Letting one slip through is exactly how a 3×6 lattice can imitate a
                // real 2×6 marker in a smooth raster.
                let markerQuietBandIsClear = gridMarkerQuietPoints.allSatisfy {
                    !isMaterial(image.brightness(x: $0.0, y: $0.1, span: sampleSpan), at: $0.0, $0.1)
                }
                guard !validationGates.requireMarkerQuietBand || markerQuietBandIsClear else {
                    recordRejection("marker-to-module M/2 background band missing", .markerQuietBandMissing, priority: 3)
                    continue
                }
                var quietPoints = gridMarkerQuietPoints
                for row in 0..<rows {
                    for column in 0..<columns where row != markerRow || column != markerColumn {
                        let centerX = (Double(column) + 1.5) * horizontalModule
                        let centerY = (Double(row) + 1.5) * verticalModule
                        if column == 0 { quietPoints.append((0.75 * horizontalModule, centerY)) }
                        if column == columns - 1 { quietPoints.append((width - 0.75 * horizontalModule, centerY)) }
                        if row == 0 { quietPoints.append((centerX, 0.75 * verticalModule)) }
                        if row == rows - 1 { quietPoints.append((centerX, height - 0.75 * verticalModule)) }
                    }
                }
                let quietHits = quietPoints.filter {
                    !isMaterial(image.brightness(x: $0.0, y: $0.1, span: sampleSpan), at: $0.0, $0.1)
                }.count
                let quietScore = Double(quietHits) / Double(quietPoints.count)
                guard !validationGates.requireModuleQuietBands || quietScore >= 0.84 else {
                    recordRejection("M/2 background band missing \(Int((quietScore * 100).rounded()))%", .moduleQuietBandMissing, priority: 3)
                    continue
                }

                var sampled: [[Open3DPC.Cell]] = []
                var confidences: [Open3DPCVisualMetrics.CellConfidence] = []
                var lowestConfidence = 1.0
                for row in 0..<rows {
                    var values: [Open3DPC.Cell] = []
                    for column in 0..<columns {
                        if row == markerRow, column == markerColumn {
                            values.append(.orientation)
                            continue
                        }
                        let fraction = materialFraction(
                            centerX: (Double(column) + 1.5) * horizontalModule,
                            centerY: (Double(row) + 1.5) * verticalModule,
                            xRadius: horizontalModule * 0.30,
                            yRadius: verticalModule * 0.30,
                            span: sampleSpan
                        )
                        let confidence = abs(fraction - 0.5) * 2
                        confidences.append(.init(row: row, column: column, confidence: confidence))
                        lowestConfidence = min(lowestConfidence, confidence)
                        values.append(fraction >= 0.5 ? .one : .zero)
                    }
                    sampled.append(values)
                }
                guard lowestConfidence >= 0.30 else {
                    recordRejection("ambiguous cell confidence \(Int((lowestConfidence * 100).rounded()))%", .ambiguousCellConfidence, priority: 4)
                    continue
                }
                let structuralScore = 0.45 * frameScore + 0.25 * markerScore + 0.20 * quietScore + 0.10 * lowestConfidence
                candidates.append(SampledMatrix(
                    matrix: Open3DPC.Matrix(rows: sampled),
                    rows: rows,
                    columns: columns,
                    module: min(horizontalModule, verticalModule),
                    edgeMaterialFraction: frameScore,
                    horizontalModule: horizontalModule,
                    verticalModule: verticalModule,
                    markerScore: markerScore,
                    quietBandScore: quietScore,
                    lowestCellConfidence: lowestConfidence,
                    diagnostics: StructuralDiagnostics(
                        interiorBackgroundScore: interiorBackground,
                        horizontalFrameThickness: horizontalThickness,
                        verticalFrameThickness: verticalThickness,
                        moduleAspectRatio: moduleAspectRatio,
                        markerCornerScore: markerScore,
                        attachedMarker: attachedMarker(
                            for: measuredMarker,
                            horizontalModule: measuredMx,
                            verticalModule: measuredMy,
                            score: measuredMarkerScore,
                            imageWidth: width,
                            imageHeight: height,
                            samplingSpace: samplingSpace
                        )
                    ),
                    cellConfidences: confidences,
                    structuralScore: structuralScore,
                    samplingGrid: .init(
                        canvasSize: samplingSpace.canvasSize,
                        outerFrame: samplingSpace.outerFrame,
                        geometry: geometry,
                        horizontalModule: horizontalModule,
                        verticalModule: verticalModule
                    )
                ))
            }
        }
        let ranked = candidates.sorted { $0.structuralScore > $1.structuralScore }
        guard let best = ranked.first else {
            return .init(
                matrices: [], rejection: rejection, reason: rejectionReason,
                diagnostics: deepestDiagnostics, hasPhysicalSignature: physicalSignatureSeen
            )
        }
        // Note for whoever widens the lattice search again: strengthening this comparison does not
        // make that safe. Dropping the 0.06 precondition and picking the best rival of a *different*
        // lattice — both tried — leaves `corners 0.25 M + sigma 0.20 M` decoding a wrong payload on
        // a 2x8, because under that stress the true 2x6 does not survive to become a candidate at
        // all. With one survivor there is nothing to compare, so the defence has to be an absolute
        // test on the winner rather than a comparative one.
        if let runnerUp = ranked.dropFirst().first,
           (runnerUp.rows != best.rows || runnerUp.columns != best.columns),
           best.structuralScore - runnerUp.structuralScore < 0.06 {
            let separation = best.lowestCellConfidence - runnerUp.lowestCellConfidence
            if separation < Self.cellConfidenceTieBreak {
                let tied = ranked.filter { best.structuralScore - $0.structuralScore < 0.06 }.sorted { $0.scaleError < $1.scaleError }
                if tied[0].scaleError <= Self.scaleAgreement,
                   tied[1].scaleError - tied[0].scaleError >= Self.scaleSeparation {
                    return .init(matrices: [tied[0]], rejection: "", diagnostics: tied[0].diagnostics, hasPhysicalSignature: true)
                }
            }
            guard separation >= Self.cellConfidenceTieBreak else {
                return .init(
                    matrices: [],
                    rejection: "ambiguous geometry hypotheses \(best.rows)×\(best.columns) / \(runnerUp.rows)×\(runnerUp.columns)",
                    reason: .ambiguousGeometry,
                    diagnostics: best.diagnostics,
                    hasPhysicalSignature: true
                )
            }
        }
        return .init(matrices: [best], rejection: "", diagnostics: best.diagnostics, hasPhysicalSignature: true)
    }

    func analyzeFixture(
        _ fixture: Open3DPCVisualFixture,
        validationGates: Open3DPCValidationGates = .strict
    ) -> Open3DPCVisualFixtureOutcome {
        guard fixture.width > 0, fixture.height > 0,
              fixture.rgba.count >= fixture.width * fixture.height * 4 else {
            return .init(id: fixture.id, stage: .sampling, geometry: nil, payload: nil, detail: "invalid fixture raster")
        }
        let sampleMark = CFAbsoluteTimeGetCurrent()
        let sampling = sampledMatricesOnEitherAxis(
            from: Raster(
                bytes: fixture.rgba,
                width: fixture.width,
                height: fixture.height,
                bytesPerRow: fixture.width * 4
            ),
            validationGates: validationGates
        )
        let sampleMilliseconds = (CFAbsoluteTimeGetCurrent() - sampleMark) * 1_000
        guard let sampled = sampling.matrices.first else {
            let stage: Stage = sampling.reason == .ambiguousCellConfidence ? .ambiguousCell : .sampling
            return .init(
                id: fixture.id, stage: stage, geometry: nil, payload: nil, detail: sampling.rejection,
                sampleMilliseconds: sampleMilliseconds
            )
        }
        switch Open3DPC.validate(sampled.matrix) {
        case .success(let value):
            return .init(
                id: fixture.id,
                stage: .validated,
                geometry: value.geometry,
                payload: value.payload,
                detail: sampled.detail,
                sampleMilliseconds: sampleMilliseconds
            )
        case .failure(.invalidGeometry):
            return .init(
                id: fixture.id, stage: .geometry, geometry: nil, payload: nil, detail: sampled.detail,
                sampleMilliseconds: sampleMilliseconds
            )
        case .failure(.invalidOrientation):
            return .init(
                id: fixture.id, stage: .orientation, geometry: nil, payload: nil, detail: sampled.detail,
                sampleMilliseconds: sampleMilliseconds
            )
        case .failure(.malformedMatrix):
            return .init(
                id: fixture.id, stage: .malformed, geometry: nil, payload: nil, detail: sampled.detail,
                sampleMilliseconds: sampleMilliseconds
            )
        case .failure(.crcMismatch):
            return .init(
                id: fixture.id, stage: .crc, geometry: nil, payload: nil, detail: sampled.detail,
                sampleMilliseconds: sampleMilliseconds
            )
        case .failure(.emptyDataRegion):
            return .init(
                id: fixture.id, stage: .emptyDataRegion, geometry: nil, payload: nil, detail: sampled.detail,
                sampleMilliseconds: sampleMilliseconds
            )
        }
    }

    private func hasSingleCornerStep(
        in luma: LumaPlane, corners: [CGPoint], threshold: Double, frameIsLight: Bool
    ) -> (runs: [Double], passes: Bool) {
        guard corners.count == 4 else { return ([], false) }
        func point(u: Double, v: Double) -> CGPoint {
            let top = CGPoint(
                x: corners[0].x + (corners[1].x - corners[0].x) * u,
                y: corners[0].y + (corners[1].y - corners[0].y) * u
            )
            let bottom = CGPoint(
                x: corners[3].x + (corners[2].x - corners[3].x) * u,
                y: corners[3].y + (corners[2].y - corners[3].y) * u
            )
            return CGPoint(x: top.x + (bottom.x - top.x) * v, y: top.y + (bottom.y - top.y) * v)
        }
        func isMaterial(_ brightness: Double) -> Bool {
            frameIsLight ? brightness > threshold : brightness < threshold
        }

        // The probe has to advance the same *distance* along both axes, not the same fraction of
        // each side. A parametric diagonal is a geometric one only on a square: on a 10 M × 3 M code
        // it is already 1.5 M down the long axis while the short axis is still inside the M/2 frame
        // line, so it leaves the M × M marker before the marker can lengthen anything and all four
        // corners return the identical run. Normalizing both axes to the shorter side keeps the
        // marker reachable at any aspect ratio, and — because the long axis is now walked in
        // short-side units — samples a strictly smaller neighbourhood of each corner than before.
        func sideLength(_ a: CGPoint, _ b: CGPoint) -> Double {
            Double(((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)).squareRoot())
        }
        let horizontalSide = (sideLength(corners[0], corners[1]) + sideLength(corners[3], corners[2])) / 2
        let verticalSide = (sideLength(corners[0], corners[3]) + sideLength(corners[1], corners[2])) / 2
        let shortestSide = min(horizontalSide, verticalSide)
        guard shortestSide > 0 else { return ([], false) }
        let uScale = shortestSide / horizontalSide
        let vScale = shortestSide / verticalSide

        // `limit` and every run below are now in units of the shorter side, so `runs[3] >= 0.03`
        // means 3% of that side at every aspect ratio instead of 3% of whichever side it fell on.
        let steps = 36
        let limit = 0.45
        let runs = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)].map { origin -> Double in
            var lastMaterial = 0.0
            var backgroundRun = 0
            for index in 1...steps {
                let distance = limit * Double(index) / Double(steps)
                let u = origin.0 == 0 ? distance * uScale : 1 - distance * uScale
                let v = origin.1 == 0 ? distance * vScale : 1 - distance * vScale
                if isMaterial(luma.brightness(atImagePoint: point(u: u, v: v))) {
                    lastMaterial = distance
                    backgroundRun = 0
                } else {
                    backgroundRun += 1
                    if backgroundRun >= 2 { break }
                }
            }
            return lastMaterial
        }

        // Longest against second longest, so the step has to be unique rather than merely present.
        // Sorted for the verdict only; `runs` goes back in the order it was walked.
        let sorted = runs.sorted()
        return (runs, sorted[3] >= 0.03 && sorted[3] >= sorted[2] * 1.6)
    }

    private func oppositeInteriorMaterial(
        in luma: LumaPlane,
        topLeft: CGPoint,
        topRight: CGPoint,
        bottomRight: CGPoint,
        bottomLeft: CGPoint
    ) -> OppositeMaterialPreflight {
        func point(u: Double, v: Double) -> CGPoint {
            let top = CGPoint(
                x: topLeft.x + (topRight.x - topLeft.x) * u,
                y: topLeft.y + (topRight.y - topLeft.y) * u
            )
            let bottom = CGPoint(
                x: bottomLeft.x + (bottomRight.x - bottomLeft.x) * u,
                y: bottomLeft.y + (bottomRight.y - bottomLeft.y) * u
            )
            return CGPoint(
                x: top.x + (bottom.x - top.x) * v,
                y: top.y + (bottom.y - top.y) * v
            )
        }
        func brightness(u: Double, v: Double) -> Double {
            luma.brightness(atImagePoint: point(u: u, v: v))
        }

        let edgeSteps = (1...8).map { Double($0) / 9 }
        let edgeBrightnesses = edgeSteps.flatMap { t in
            [
                brightness(u: t, v: 0.025),
                brightness(u: t, v: 0.975),
                brightness(u: 0.025, v: t),
                brightness(u: 0.975, v: t),
            ]
        }
        let interiorSteps = (1...9).map { 0.1 + Double($0 - 1) * 0.1 }
        let interiorBrightnesses = interiorSteps.flatMap { v in
            interiorSteps.map { u in brightness(u: u, v: v) }
        }
        let samples = edgeBrightnesses + interiorBrightnesses
        guard let minimum = samples.min(), let maximum = samples.max() else {
            return .init(oppositeMaterialScore: 0, hasOppositeMaterial: false)
        }
        let contrastSpan = maximum - minimum
        guard contrastSpan >= 28 else {
            // The span goes out with the rejection rather than being dropped with it: "flat" and
            // "flat by 3 counts out of the 28 it needed" are different findings.
            return .init(
                oppositeMaterialScore: 0, hasOppositeMaterial: false, contrastSpan: contrastSpan
            )
        }
        let frameBrightness = edgeBrightnesses.reduce(0, +) / Double(edgeBrightnesses.count)
        let threshold = (minimum + maximum) / 2
        let frameIsLight = frameBrightness > threshold
        let oppositeCount = interiorBrightnesses.filter { brightness in
            frameIsLight ? brightness < threshold : brightness > threshold
        }.count
        let score = Double(oppositeCount) / Double(interiorBrightnesses.count)
        return .init(
            oppositeMaterialScore: score, hasOppositeMaterial: score >= 0.01,
            threshold: threshold, frameIsLight: frameIsLight, contrastSpan: contrastSpan
        )
    }

    private struct ThresholdField {
        let minimum: Double
        let maximum: Double
        private let width: Double
        private let height: Double
        private let base: Double
        private let perX: Double
        private let perY: Double

        var contrast: Double { maximum - minimum }
        /// True when the fit found a real gradient rather than falling back to a flat threshold.
        var isGraded: Bool { perX != 0 || perY != 0 }

        init(image: Raster, span: Double) {
            width = Double(image.width)
            height = Double(image.height)
            let steps = 12
            var samples: [(x: Double, y: Double, value: Double)] = []
            for row in 1...steps {
                for column in 1...steps {
                    let x = Double(column) / Double(steps + 1)
                    let y = Double(row) / Double(steps + 1)
                    samples.append((x, y, image.brightness(x: width * x, y: height * y, span: span)))
                }
            }
            let values = samples.map(\.value)
            minimum = values.min() ?? 0
            maximum = values.max() ?? 0
            let flat = (minimum + maximum) / 2
            let globalContrast = maximum - minimum

            // One vote per tile, at its centre, from tiles that saw both classes. A tile covering
            // only background has no opinion about where the boundary lies and must not supply one.
            let tiles = 4
            var points: [(x: Double, y: Double, threshold: Double)] = []
            for tileRow in 0..<tiles {
                for tileColumn in 0..<tiles {
                    let inside = samples.filter {
                        Int($0.x * Double(tiles)) == tileColumn && Int($0.y * Double(tiles)) == tileRow
                    }
                    guard let low = inside.map(\.value).min(), let high = inside.map(\.value).max(),
                          high - low >= globalContrast * 0.5 else { continue }
                    points.append((
                        (Double(tileColumn) + 0.5) / Double(tiles),
                        (Double(tileRow) + 0.5) / Double(tiles),
                        (low + high) / 2
                    ))
                }
            }
            guard points.count >= 4 else {
                base = flat; perX = 0; perY = 0
                return
            }
            let n = Double(points.count)
            let sumX = points.reduce(0) { $0 + $1.x }, sumY = points.reduce(0) { $0 + $1.y }
            let sumXX = points.reduce(0) { $0 + $1.x * $1.x }, sumYY = points.reduce(0) { $0 + $1.y * $1.y }
            let sumXY = points.reduce(0) { $0 + $1.x * $1.y }
            let sumT = points.reduce(0) { $0 + $1.threshold }
            let sumXT = points.reduce(0) { $0 + $1.x * $1.threshold }
            let sumYT = points.reduce(0) { $0 + $1.y * $1.threshold }
            let determinant = n * (sumXX * sumYY - sumXY * sumXY)
                - sumX * (sumX * sumYY - sumXY * sumY)
                + sumY * (sumX * sumXY - sumXX * sumY)
            guard abs(determinant) > 1e-9 else {
                base = flat; perX = 0; perY = 0
                return
            }
            func solve(_ c0: Double, _ c1: Double, _ c2: Double, column: Int) -> Double {
                var m = [[n, sumX, sumY], [sumX, sumXX, sumXY], [sumY, sumXY, sumYY]]
                m[0][column] = c0; m[1][column] = c1; m[2][column] = c2
                let value = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
                    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
                    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
                return value / determinant
            }
            let fittedBase = solve(sumT, sumXT, sumYT, column: 0)
            let fittedPerX = solve(sumT, sumXT, sumYT, column: 1)
            let fittedPerY = solve(sumT, sumXT, sumYT, column: 2)

            let spread = abs(fittedPerX) + abs(fittedPerY)
            guard spread >= globalContrast * 0.25 else {
                base = flat; perX = 0; perY = 0
                return
            }
            base = fittedBase; perX = fittedPerX; perY = fittedPerY
        }

        /// Clamped well inside the observed range: a plane fitted to a handful of tiles must never
        /// extrapolate past the point where everything, or nothing, is material.
        func callAsFunction(_ x: Double, _ y: Double) -> Double {
            guard isGraded else { return base }
            let value = base + perX * (x / width) + perY * (y / height)
            return min(max(value, minimum + contrast * 0.2), maximum - contrast * 0.2)
        }
    }

    /// `achromatic` is the mean of the three channels, right for materials that differ in brightness.
    /// `chromatic` is green against magenta on the same 0...255 scale, for pairs that differ in hue.
    private enum MaterialAxis {
        case achromatic
        case chromatic
    }

    private struct Raster {
        let bytes: Data
        let width: Int
        let height: Int
        let bytesPerRow: Int
        /// Defaulted, so every existing construction site keeps the projection it always had.
        var axis: MaterialAxis = .achromatic

        /// Puts the chromatic projection where a brightness separation of comparable quality would
        /// sit on the same scale, rather than leaving it clustered around zero where a gate written
        /// for brightness would reject it. Not a detection-strength knob.
        private static let chromaticBase = 128.0
        private static let chromaticGain = 3.0

        /// The same bytes, read as though material meant something else. No copy: the projection is
        /// applied per sample, and a raster is only ever re-viewed after its own axis found nothing.
        func on(_ axis: MaterialAxis) -> Raster {
            Raster(bytes: bytes, width: width, height: height, bytesPerRow: bytesPerRow, axis: axis)
        }

        /// `CGImage` byte rows are top-down; perspective-correction output is sampled in that
        /// same visual coordinate system so protocol row zero is its top row.
        func brightness(x: Double, y: Double, span: Double, minimumHalf: Int = 1) -> Double {
            let half = max(minimumHalf, Int(span / 2))
            let centerX = min(max(Int(x.rounded()), 0), width - 1)
            let centerY = min(max(Int(y.rounded()), 0), height - 1)
            let rows = max(0, centerY - half)...min(height - 1, centerY + half)
            let columns = max(0, centerX - half)...min(width - 1, centerX + half)
            switch axis {
            case .achromatic:
                // Deliberately integer and deliberately unchanged: a frame that decodes today must
                // decode to the same bits, down to the last rounding, after this axis existed.
                var total = 0
                var samples = 0
                for row in rows {
                    for column in columns {
                        let index = row * bytesPerRow + column * 4
                        total += Int(bytes[index]) + Int(bytes[index + 1]) + Int(bytes[index + 2])
                        samples += 3
                    }
                }
                return samples > 0 ? Double(total) / Double(samples) : 0
            case .chromatic:
                var total = 0.0
                var samples = 0
                for row in rows {
                    for column in columns {
                        let index = row * bytesPerRow + column * 4
                        let red = Double(bytes[index])
                        let green = Double(bytes[index + 1])
                        let blue = Double(bytes[index + 2])
                        total += Self.chromaticBase + Self.chromaticGain * (green - (red + blue) / 2)
                        samples += 1
                    }
                }
                return samples > 0 ? total / Double(samples) : 0
            }
        }

        func cropped(to rect: CGRect) -> Raster? {
            let crop = rect.integral.intersection(CGRect(x: 0, y: 0, width: width, height: height))
            guard !crop.isNull,
                  let x = Int(exactly: crop.minX),
                  let y = Int(exactly: crop.minY),
                  let cropWidth = Int(exactly: crop.width),
                  let cropHeight = Int(exactly: crop.height),
                  cropWidth >= 8,
                  cropHeight >= 8 else { return nil }
            let rowWidth = cropWidth * 4
            var output = Data()
            output.reserveCapacity(rowWidth * cropHeight)
            for row in y..<(y + cropHeight) {
                let start = row * bytesPerRow + x * 4
                output.append(bytes[start..<(start + rowWidth)])
            }
            // The crop inherits the projection: a crop that disagreed with its parent about what
            // material means would measure one code by two definitions.
            return Raster(
                bytes: output, width: cropWidth, height: cropHeight, bytesPerRow: rowWidth, axis: axis
            )
        }
    }

    private func imageData(from image: CIImage) -> Raster? {
        let extent = image.extent.integral
        guard extent.width >= 8, extent.height >= 8,
              let cgImage = context.createCGImage(image, from: extent, format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB()),
              let provider = cgImage.dataProvider,
              let data = provider.data else {
            return nil
        }
        return Raster(
            bytes: data as Data,
            width: cgImage.width,
            height: cgImage.height,
            bytesPerRow: cgImage.bytesPerRow
        )
    }
}
