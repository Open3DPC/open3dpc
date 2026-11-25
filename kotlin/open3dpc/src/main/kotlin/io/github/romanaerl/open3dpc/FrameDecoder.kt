// Copyright 2026 Roman Simonov. Licensed under the Apache License, Version 2.0.

package io.github.romanaerl.open3dpc

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/** What one candidate reached: the deepest stage, with its rejection. */
internal data class Open3DPCObservation(
    val stage: Open3DPCStage,
    val payload: String?,
    val height: Int?,
    val width: Int?,
    val hasPhysicalSignature: Boolean,
    val corners: List<FramePoint>,
    val detail: String,
    val rejection: Open3DPCRejection,
    val outerFrameScore: Double?,
    val trackId: Long = 0,
)

/** Builds the raster the sampler reads: full-range BT.601 from the Y plane and the interleaved chroma. */
internal fun rectify(frame: Open3DPCFrame, quad: List<FramePoint>): Raster? {
    val (width, height) = Perspective.rectifiedSize(quad)
    if (width < 8 || height < 8 || width > 4096 || height > 4096) return null
    val destination = listOf(FramePoint(0.0, 0.0), FramePoint(width - 1.0, 0.0), FramePoint(width - 1.0, height - 1.0), FramePoint(0.0, height - 1.0))
    val map = Homography.mapping(destination, quad) ?: return null
    val output = ByteArray(width * height * 4)
    val chroma = frame.chroma
    val chromaWidth = frame.width / 2
    val chromaHeight = frame.height / 2
    var index = 0
    for (row in 0 until height) for (column in 0 until width) {
        val x = map.applyX(column.toDouble(), row.toDouble())
        val y = map.applyY(column.toDouble(), row.toDouble())
        val luma = bilinear(frame.luma, frame.rowStride, 1, frame.width, frame.height, x, y)
        if (chroma == null) {
            val value = swiftRound(luma).toInt().toByte()
            output[index] = value; output[index + 1] = value; output[index + 2] = value
        } else {
            val u = bilinear(chroma, frame.width, 2, chromaWidth, chromaHeight, x / 2 - 0.25, y / 2 - 0.25) - 128
            val v = bilinear(chroma, frame.width, 2, chromaWidth, chromaHeight, x / 2 - 0.25, y / 2 - 0.25, 1) - 128
            output[index] = swiftRound(luma + 1.402 * v).toInt().coerceIn(0, 255).toByte()
            output[index + 1] = swiftRound(luma - 0.344136 * u - 0.714136 * v).toInt().coerceIn(0, 255).toByte()
            output[index + 2] = swiftRound(luma + 1.772 * u).toInt().coerceIn(0, 255).toByte()
        }
        output[index + 3] = -1
        index += 4
    }
    return Raster(output, width, height, width * 4)
}

/**
 * Proposals, the two cheap gates, the wide crop and its second pass, registration, sampling on either
 * axis, validation, clustering and tracks. Corners are buffer pixels.
 */
internal class Open3DPCFrameDecoder(
    private val coarse: QuadProposalGenerator = ContourQuads.coarse(),
    private val second: QuadProposalGenerator = ContourQuads.second(),
) {
    private var nextSourceFrame = 0L
    private var nextTrack = 0L
    private class Track(val id: Long, var left: Double, var top: Double, var right: Double, var bottom: Double, var lastFrame: Long)
    private val tracks = ArrayList<Track>()

    fun analyze(frame: Open3DPCFrame, roi: FrameRect = FrameRect(0f, 0f, frame.width.toFloat(), frame.height.toFloat()), gates: Open3DPCGates = Open3DPCGates.Strict): List<Open3DPCObservation> {
        val sourceFrame = ++nextSourceFrame
        rectifiedCandidates = 0
        val registered = ArrayList<Registered>()
        val raw = ArrayList<Open3DPCObservation>()
        for (proposal in coarse.proposals(frame, roi)) {
            val quad = proposal.map { FramePoint(it.x.toDouble(), it.y.toDouble()) }
            // A code's outer contour and its inner opening are one code: once it validated, the
            // clustering below would discard the other reading anyway, and it costs a phone a frame.
            if (raw.any { it.stage == Open3DPCStage.Validated && overlap(bounds(it.corners), bounds(quad)) >= CLUSTER_OVERLAP }) continue
            analyze(frame, quad, gates, registered)?.let { raw += it }
        }
        return cluster(raw, sourceFrame)
    }

    /** How many rasters the last frame cost. */
    internal var rectifiedCandidates = 0
        private set

    /** One registration per frame: overlapping proposals propose the same second-pass quads. */
    private class Registered(val candidate: List<FramePoint>, val corners: List<FramePoint>, val sampling: SamplingResult?)

    /** One physical code per overlap cluster, the deepest and best-framed reading of it. */
    private fun cluster(observations: List<Open3DPCObservation>, sourceFrame: Long): List<Open3DPCObservation> {
        val clusters = ArrayList<ArrayList<Open3DPCObservation>>()
        for (observation in observations) {
            val home = clusters.firstOrNull { cluster -> cluster.any { overlap(bounds(observation.corners), bounds(it.corners)) >= CLUSTER_OVERLAP } }
            if (home != null) home += observation else clusters += arrayListOf(observation)
        }
        return clusters.map { cluster ->
            var selected = cluster[0]
            for (other in cluster.drop(1)) {
                val better = if (selected.stage != other.stage) selected.stage < other.stage else (selected.outerFrameScore ?: 0.0) < (other.outerFrameScore ?: 0.0)
                if (better) selected = other
            }
            assigningTrack(selected, sourceFrame)
        }
    }

    private fun assigningTrack(observation: Open3DPCObservation, sourceFrame: Long): Open3DPCObservation {
        val box = bounds(observation.corners)
        tracks.removeAll { sourceFrame > it.lastFrame + 12 }
        val existing = tracks.firstOrNull { overlap(box, doubleArrayOf(it.left, it.top, it.right, it.bottom)) >= 0.35 }
        val id = if (existing != null) {
            existing.left = box[0]; existing.top = box[1]; existing.right = box[2]; existing.bottom = box[3]; existing.lastFrame = sourceFrame
            existing.id
        } else (++nextTrack).also { tracks += Track(it, box[0], box[1], box[2], box[3], sourceFrame) }
        return observation.copy(trackId = id)
    }

    private fun bounds(corners: List<FramePoint>) = doubleArrayOf(corners.minOf { it.x }, corners.minOf { it.y }, corners.maxOf { it.x }, corners.maxOf { it.y })

    private fun overlap(a: DoubleArray, b: DoubleArray): Double {
        val width = min(a[2], b[2]) - max(a[0], b[0])
        val height = min(a[3], b[3]) - max(a[1], b[1])
        if (width < 0 || height < 0) return 0.0
        val intersection = width * height
        val union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - intersection
        return if (union > 0) intersection / union else 0.0
    }

    private fun rejected(corners: List<FramePoint>, rejection: Open3DPCRejection, detail: String, stage: Open3DPCStage = Open3DPCStage.Frame) =
        Open3DPCObservation(stage, null, null, null, false, corners, detail, rejection, null)

    private fun analyze(frame: Open3DPCFrame, corners: List<FramePoint>, gates: Open3DPCGates, registered: MutableList<Registered>): Open3DPCObservation? {
        val coarsePreflight = oppositeInteriorMaterial(frame, corners)
        if (!coarsePreflight.hasOppositeMaterial) return rejected(corners, Open3DPCRejection.CoarseProposalLacksOppositeMaterial, "proposal interior is a single colour")
        if (gates.requireUniqueCornerStep && !hasSingleCornerStep(frame, corners, coarsePreflight.threshold, coarsePreflight.frameIsLight))
            return rejected(corners, Open3DPCRejection.NoCornerStep, "no unique inward corner step")

        val crop = wideCrop(frame, corners) ?: return null
        val secondary = second.proposals(frame, crop).map { quad -> quad.map { FramePoint(it.x.toDouble(), it.y.toDouble()) } }
        if (secondary.isEmpty()) return rejected(corners, Open3DPCRejection.NoSecondPassRectangle, "wide crop has no second-pass rectangle")

        var selectedCorners: List<FramePoint>? = null
        var selected: SamplingResult? = null
        for (candidate in secondary) {
            val known = registered.firstOrNull { sameQuad(it.candidate, candidate) } ?: registration(frame, candidate, gates).also { registered += it }
            val sampling = known.sampling ?: continue
            if (selected == null || LatticeSampler.samplingPriority(selected) < LatticeSampler.samplingPriority(sampling)) { selected = sampling; selectedCorners = known.corners }
        }
        val sampling = selected ?: return rejected(corners, Open3DPCRejection.SecondPassLacksOppositeMaterial, "second-pass rectangle lacks opposite material")
        return judged(sampling, selectedCorners!!)
    }

    private fun registration(frame: Open3DPCFrame, candidate: List<FramePoint>, gates: Open3DPCGates): Registered {
        val corners = Perspective.expanded(candidate)
        if (!oppositeInteriorMaterial(frame, candidate).hasOppositeMaterial) return Registered(candidate, corners, null)
        val image = rectify(frame, corners) ?: return Registered(candidate, corners, null)
        rectifiedCandidates++
        return Registered(candidate, corners, LatticeSampler.sampledMatricesOnEitherAxis(image, gates))
    }

    private fun sameQuad(a: List<FramePoint>, b: List<FramePoint>) = a.indices.all { Perspective.distance(a[it], b[it]) <= SAME_QUAD_PIXELS }

    private fun judged(sampling: SamplingResult, corners: List<FramePoint>): Open3DPCObservation {
        val sampled = sampling.matrices.firstOrNull() ?: return rejected(corners, sampling.reason, sampling.rejection,
            if (sampling.reason == Open3DPCRejection.AmbiguousCellConfidence) Open3DPCStage.AmbiguousCell else Open3DPCStage.Sampling).copy(hasPhysicalSignature = sampling.hasPhysicalSignature)
        fun failed(stage: Open3DPCStage) = Open3DPCObservation(stage, null, sampled.rows, sampled.columns, true, corners, sampled.detail, Open3DPCRejection.None, sampled.edgeMaterialFraction)
        return when (val verdict = validatePhysical(sampled.matrix)) {
            is PhysicalVerdict.Valid -> Open3DPCObservation(Open3DPCStage.Validated, verdict.payload, verdict.height, verdict.width, true,
                corners, sampled.detail, Open3DPCRejection.None, sampled.edgeMaterialFraction)
            PhysicalVerdict.InvalidGeometry -> failed(Open3DPCStage.Geometry)
            PhysicalVerdict.InvalidOrientation -> failed(Open3DPCStage.Orientation)
            PhysicalVerdict.Malformed -> failed(Open3DPCStage.Malformed)
            PhysicalVerdict.CrcMismatch -> failed(Open3DPCStage.Crc)
            PhysicalVerdict.EmptyDataRegion -> failed(Open3DPCStage.EmptyDataRegion)
        }
    }

    private fun wideCrop(frame: Open3DPCFrame, corners: List<FramePoint>): FrameRect? {
        val box = bounds(corners)
        val outsetX = (box[2] - box[0]) * 0.26
        val outsetY = (box[3] - box[1]) * 0.26
        val left = max(floor(box[0] - outsetX), 0.0)
        val top = max(floor(box[1] - outsetY), 0.0)
        val right = min(ceil(box[2] + outsetX), frame.width.toDouble())
        val bottom = min(ceil(box[3] + outsetY), frame.height.toDouble())
        if (right - left < 16 || bottom - top < 16) return null
        return FrameRect(left.toFloat(), top.toFloat(), right.toFloat(), bottom.toFloat())
    }

    private class Preflight(val score: Double, val hasOppositeMaterial: Boolean, val threshold: Double = 0.0, val frameIsLight: Boolean = false)

    private fun luma(frame: Open3DPCFrame, x: Double, y: Double): Double {
        val column = min(max(swiftRound(x).toInt(), 0), frame.width - 1)
        val row = min(max(swiftRound(y).toInt(), 0), frame.height - 1)
        return (frame.luma[row * frame.rowStride + column].toInt() and 255).toDouble()
    }

    private fun bilinearPoint(corners: List<FramePoint>, u: Double, v: Double): FramePoint {
        val topX = corners[0].x + (corners[1].x - corners[0].x) * u
        val topY = corners[0].y + (corners[1].y - corners[0].y) * u
        val bottomX = corners[3].x + (corners[2].x - corners[3].x) * u
        val bottomY = corners[3].y + (corners[2].y - corners[3].y) * u
        return FramePoint(topX + (bottomX - topX) * v, topY + (bottomY - topY) * v)
    }

    private fun oppositeInteriorMaterial(frame: Open3DPCFrame, corners: List<FramePoint>): Preflight {
        fun brightness(u: Double, v: Double): Double { val point = bilinearPoint(corners, u, v); return luma(frame, point.x, point.y) }
        val edge = ArrayList<Double>(32)
        for (step in 1..8) {
            val t = step.toDouble() / 9
            edge += brightness(t, 0.025); edge += brightness(t, 0.975); edge += brightness(0.025, t); edge += brightness(0.975, t)
        }
        val interior = ArrayList<Double>(81)
        for (row in 0 until 9) for (column in 0 until 9) interior += brightness(0.1 + column * 0.1, 0.1 + row * 0.1)
        val minimum = min(edge.min(), interior.min())
        val maximum = max(edge.max(), interior.max())
        if (maximum - minimum < 28) return Preflight(0.0, false)
        val threshold = (minimum + maximum) / 2
        val frameIsLight = edge.sum() / edge.size > threshold
        val opposite = interior.count { if (frameIsLight) it < threshold else it > threshold }
        val score = opposite.toDouble() / interior.size
        return Preflight(score, score >= 0.01, threshold, frameIsLight)
    }

    private fun hasSingleCornerStep(frame: Open3DPCFrame, corners: List<FramePoint>, threshold: Double, frameIsLight: Boolean): Boolean {
        fun length(a: FramePoint, b: FramePoint) = sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y))
        val horizontalSide = (length(corners[0], corners[1]) + length(corners[3], corners[2])) / 2
        val verticalSide = (length(corners[0], corners[3]) + length(corners[1], corners[2])) / 2
        val shortest = min(horizontalSide, verticalSide)
        if (shortest <= 0) return false
        val uScale = shortest / horizontalSide
        val vScale = shortest / verticalSide
        val steps = 36
        val limit = 0.45
        val runs = DoubleArray(4)
        for ((corner, origin) in CORNER_ORIGINS.withIndex()) {
            var lastMaterial = 0.0
            var backgroundRun = 0
            for (index in 1..steps) {
                val distance = limit * index / steps
                val u = if (origin.first == 0.0) distance * uScale else 1 - distance * uScale
                val v = if (origin.second == 0.0) distance * vScale else 1 - distance * vScale
                val point = bilinearPoint(corners, u, v)
                val brightness = luma(frame, point.x, point.y)
                if (if (frameIsLight) brightness > threshold else brightness < threshold) {
                    lastMaterial = distance
                    backgroundRun = 0
                } else if (++backgroundRun >= 2) break
            }
            runs[corner] = lastMaterial
        }
        runs.sort()
        return runs[3] >= 0.03 && runs[3] >= runs[2] * 1.6
    }

    private companion object {
        const val CLUSTER_OVERLAP = 0.45
        const val SAME_QUAD_PIXELS = 1.0
        val CORNER_ORIGINS = listOf(0.0 to 0.0, 1.0 to 0.0, 1.0 to 1.0, 0.0 to 1.0)
    }
}
