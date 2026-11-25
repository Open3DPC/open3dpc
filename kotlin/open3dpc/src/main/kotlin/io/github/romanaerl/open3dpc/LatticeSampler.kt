// Copyright 2026 Roman Simonov. Licensed under the Apache License, Version 2.0.

package io.github.romanaerl.open3dpc

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/** The measurements that establish a physical code before any payload bit is sampled. */
internal class StructuralDiagnostics(
    val interiorBackgroundScore: Double,
    val horizontalFrameThickness: Double? = null,
    val verticalFrameThickness: Double? = null,
    val moduleAspectRatio: Double? = null,
    val markerCornerScore: Double? = null,
)

internal class SampledMatrix(
    val matrix: List<String>,
    val rows: Int,
    val columns: Int,
    val edgeMaterialFraction: Double,
    val horizontalModule: Double,
    val verticalModule: Double,
    val markerScore: Double,
    val quietBandScore: Double,
    val lowestCellConfidence: Double,
    val diagnostics: StructuralDiagnostics,
    val structuralScore: Double,
) {
    val detail get() = "grid $rows×$columns · Mx/My ${format1(horizontalModule)}/${format1(verticalModule)} px · frame ${swiftRound(edgeMaterialFraction * 100).toInt()}%"
}

internal class SamplingResult(
    val matrices: List<SampledMatrix>,
    val rejection: String,
    val reason: Open3DPCRejection = Open3DPCRejection.None,
    val diagnostics: StructuralDiagnostics? = null,
    val hasPhysicalSignature: Boolean = false,
)

/** What `analyzeFixture` reports: the physical verdict on a raster that is already registered. */
internal class RasterOutcome(val stage: Open3DPCStage, val height: Int?, val width: Int?, val payload: String?, val detail: String, val reason: Open3DPCRejection)

/**
 * The structural half of the reader, the same constants and the same order of gates as the Swift one,
 * which explains each gate beside its code. It starts after perspective registration and knows nothing
 * about a camera. See docs/reader-pipeline.md.
 */
internal object LatticeSampler {
    /** How far the leader must beat the runner-up on its least confident cell to settle a tie. */
    private const val CELL_CONFIDENCE_TIE_BREAK = 0.10

    /** `analyzeFixture`. */
    fun analyze(raster: Raster, gates: Open3DPCGates = Open3DPCGates.Strict): RasterOutcome {
        val sampling = sampledMatricesOnEitherAxis(raster, gates)
        val sampled = sampling.matrices.firstOrNull() ?: return RasterOutcome(
            if (sampling.reason == Open3DPCRejection.AmbiguousCellConfidence) Open3DPCStage.AmbiguousCell else Open3DPCStage.Sampling,
            null, null, null, sampling.rejection, sampling.reason,
        )
        return when (val verdict = validatePhysical(sampled.matrix)) {
            is PhysicalVerdict.Valid -> RasterOutcome(Open3DPCStage.Validated, verdict.height, verdict.width, verdict.payload, sampled.detail, Open3DPCRejection.None)
            PhysicalVerdict.InvalidGeometry -> RasterOutcome(Open3DPCStage.Geometry, null, null, null, sampled.detail, Open3DPCRejection.None)
            PhysicalVerdict.InvalidOrientation -> RasterOutcome(Open3DPCStage.Orientation, null, null, null, sampled.detail, Open3DPCRejection.None)
            PhysicalVerdict.Malformed -> RasterOutcome(Open3DPCStage.Malformed, null, null, null, sampled.detail, Open3DPCRejection.None)
            PhysicalVerdict.CrcMismatch -> RasterOutcome(Open3DPCStage.Crc, null, null, null, sampled.detail, Open3DPCRejection.None)
            PhysicalVerdict.EmptyDataRegion -> RasterOutcome(Open3DPCStage.EmptyDataRegion, null, null, null, sampled.detail, Open3DPCRejection.None)
        }
    }

    /** The chromatic projection is a second attempt, selected by outcome and never by a statistic. */
    fun sampledMatricesOnEitherAxis(image: Raster, gates: Open3DPCGates): SamplingResult {
        val first = sampledMatrices(image, gates)
        if (first.matrices.isNotEmpty() || image.axis == MaterialAxis.Chromatic) return first
        val chromatic = sampledMatrices(image.on(MaterialAxis.Chromatic), gates)
        return if (samplingPriority(chromatic) > samplingPriority(first)) chromatic else first
    }

    fun samplingPriority(result: SamplingResult): Double {
        val physical = if (result.hasPhysicalSignature) 10_000.0 else 0.0
        val decoded = if (result.matrices.isEmpty()) 0.0 else 1_000.0
        val measurements = if (result.diagnostics?.horizontalFrameThickness != null) 100.0 else 0.0
        return physical + decoded + measurements + (result.diagnostics?.markerCornerScore ?: 0.0)
    }

    private fun sampledMatrices(image: Raster, gates: Open3DPCGates): SamplingResult {
        val raw = sampledMatricesCore(image, gates)
        val refined = refinedOuterFrame(image) ?: return raw
        val registered = sampledMatricesCore(refined, gates)
        if ((registered.hasPhysicalSignature || !raw.hasPhysicalSignature) && registered.diagnostics?.horizontalFrameThickness != null) return registered
        return raw
    }

    private fun median(values: List<Double>): Double? = if (values.isEmpty()) null else values.sorted()[values.size / 2]

    private class AxisLine(val position: Double, val score: Double)
    private class Ring(val left: AxisLine, val right: AxisLine, val top: AxisLine, val bottom: AxisLine, val materialIsLight: Boolean, val oppositeInteriorScore: Double) {
        val score get() = (left.score + right.score + top.score + bottom.score) / 4 + oppositeInteriorScore * 0.30
        val area get() = (right.position - left.position) * (bottom.position - top.position)
    }

    /** `refinedOuterFrame`: the material ring inside the proposal's neighbourhood, innermost sound ring first. */
    private fun refinedOuterFrame(image: Raster): Raster? {
        val width = image.width.toDouble()
        val height = image.height.toDouble()
        val shortestSide = min(width, height)
        if (shortestSide < 24) return null
        val probeSpan = max(1.0, shortestSide / 220)
        val samples = 15
        val field = ThresholdField(image, probeSpan)
        if (field.contrast < 28) return null

        fun material(x: Double, y: Double, span: Double, materialIsLight: Boolean, minimumHalf: Int = 1): Boolean {
            val brightness = image.brightness(x, y, span, minimumHalf)
            val threshold = field(x, y)
            return if (materialIsLight) brightness > threshold else brightness < threshold
        }

        fun lineScore(position: Double, vertical: Boolean, materialIsLight: Boolean, crossFrom: Double = 0.0, crossTo: Double = 1.0): Double {
            val span = max(0.05, crossTo - crossFrom)
            var hits = 0
            for (index in 1..samples) {
                val fraction = crossFrom + span * index / (samples + 1)
                val x = if (vertical) position else width * fraction
                val y = if (vertical) height * fraction else position
                if (material(x, y, probeSpan, materialIsLight)) hits++
            }
            return hits.toDouble() / samples
        }

        fun candidateLines(lower: Double, upper: Double, vertical: Boolean, materialIsLight: Boolean, outermostFirst: Boolean): List<AxisLine> {
            val limit = if (vertical) width else height
            val start = max(0, ceil(limit * lower).toInt())
            val end = min(limit.toInt() - 1, floor(limit * upper).toInt())
            if (start > end) return emptyList()
            val bands = ArrayList<AxisLine>()
            var runFirst = -1.0
            var runLast = -1.0
            var runBest = 0.0
            fun close() {
                if (runFirst < 0) return
                bands += AxisLine((runFirst + runLast) / 2, runBest)
                runFirst = -1.0
                runBest = 0.0
            }
            for (position in start..end) {
                val score = lineScore(position.toDouble(), vertical, materialIsLight)
                if (score >= 0.60) {
                    if (runFirst < 0) runFirst = position.toDouble()
                    runLast = position.toDouble()
                    runBest = max(runBest, score)
                } else close()
            }
            close()
            return (if (outermostFirst) bands else bands.reversed()).take(3)
        }

        fun materialRun(line: AxisLine, vertical: Boolean, materialIsLight: Boolean, crossFrom: Double, crossTo: Double): Double? {
            val limit = if (vertical) width else height
            val crossLimit = if (vertical) height else width
            val crossSpan = max(0.05, crossTo - crossFrom)
            fun runs(fractions: DoubleArray): List<Double> {
                val output = ArrayList<Double>(fractions.size)
                for (fraction in fractions) {
                    val cross = crossLimit * (crossFrom + crossSpan * fraction)
                    fun isMaterial(position: Double) = material(if (vertical) position else cross, if (vertical) cross else position, 0.0, materialIsLight, 0)
                    if (!isMaterial(line.position)) continue
                    var low = line.position
                    while (low > 0 && isMaterial(low - 1)) low -= 1
                    var high = line.position
                    while (high < limit - 1 && isMaterial(high + 1)) high += 1
                    output += high - low + 1
                }
                return output
            }
            val near = median(runs(doubleArrayOf(0.20, 0.28, 0.36, 0.44)))
            val far = median(runs(doubleArrayOf(0.56, 0.64, 0.72, 0.80)))
            return if (near != null && far != null) min(near, far) else near ?: far
        }

        fun oppositeInteriorScore(ring: Ring): Double {
            val x0 = ring.left.position
            val x1 = ring.right.position
            val y0 = ring.top.position
            val y1 = ring.bottom.position
            if (x1 - x0 < 12 || y1 - y0 < 12) return 0.0
            var count = 0
            for (row in 2..8) for (column in 2..8) {
                val x = x0 + (x1 - x0) * column / 10
                val y = y0 + (y1 - y0) * row / 10
                val brightness = image.brightness(x, y, probeSpan)
                val threshold = field(x, y)
                if (if (ring.materialIsLight) brightness < threshold else brightness > threshold) count++
            }
            return count.toDouble() / 49
        }

        fun hasCornerStep(ring: Ring): Boolean {
            val x0 = ring.left.position
            val x1 = ring.right.position
            val y0 = ring.top.position
            val y1 = ring.bottom.position
            val ringWidth = x1 - x0
            val ringHeight = y1 - y0
            val shortest = min(ringWidth, ringHeight)
            if (shortest <= 0) return false
            val uScale = shortest / ringWidth
            val vScale = shortest / ringHeight
            val steps = 24
            val limit = 0.45
            val runs = DoubleArray(4)
            for ((corner, origin) in CORNER_ORIGINS.withIndex()) {
                var lastMaterial = 0.0
                var backgroundRun = 0
                for (index in 1..steps) {
                    val distance = limit * index / steps
                    val u = if (origin.first == 0.0) distance * uScale else 1 - distance * uScale
                    val v = if (origin.second == 0.0) distance * vScale else 1 - distance * vScale
                    if (material(x0 + (x1 - x0) * u, y0 + (y1 - y0) * v, probeSpan, ring.materialIsLight)) {
                        lastMaterial = distance
                        backgroundRun = 0
                    } else if (++backgroundRun >= 2) break
                }
                runs[corner] = lastMaterial
            }
            runs.sort()
            return runs[3] >= 0.03 && runs[3] >= runs[2] * 1.6
        }

        fun refinedFrame(ring: Ring): Raster? {
            val crossX = ring.left.position / width to ring.right.position / width
            val crossY = ring.top.position / height to ring.bottom.position / height
            val leftThickness = materialRun(ring.left, true, ring.materialIsLight, crossY.first, crossY.second) ?: return null
            val rightThickness = materialRun(ring.right, true, ring.materialIsLight, crossY.first, crossY.second) ?: return null
            val topThickness = materialRun(ring.top, false, ring.materialIsLight, crossX.first, crossX.second) ?: return null
            val bottomThickness = materialRun(ring.bottom, false, ring.materialIsLight, crossX.first, crossX.second) ?: return null
            val outerWidth = ring.right.position - ring.left.position + (leftThickness + rightThickness) / 2
            val outerHeight = ring.bottom.position - ring.top.position + (topThickness + bottomThickness) / 2
            val maximumThinFrame = min(outerWidth, outerHeight) * 0.18
            val maximumThicknessDisparity = 0.55
            if (maxOf(leftThickness, rightThickness, max(topThickness, bottomThickness)) > maximumThinFrame ||
                abs(leftThickness - rightThickness) / max(leftThickness, rightThickness) > maximumThicknessDisparity ||
                abs(topThickness - bottomThickness) / max(topThickness, bottomThickness) > maximumThicknessDisparity) return null
            // A row of data cells can score as a side of the ring. Only a frame side reaches its neighbours:
            // between a data row and the frame the format keeps an M/2 gap, so look there.
            val l = ring.left.position; val r = ring.right.position; val u = ring.top.position; val d = ring.bottom.position
            val sideEnds = listOf(
                l + leftThickness to u, r - rightThickness to u, l + leftThickness to d, r - rightThickness to d,
                l to u + topThickness, l to d - bottomThickness, r to u + topThickness, r to d - bottomThickness,
            )
            if (sideEnds.count { (x, y) -> material(x, y, probeSpan, ring.materialIsLight) } < 7) return null
            var backgrounds = 0
            var total = 0
            for (fraction in doubleArrayOf(0.22, 0.36, 0.50, 0.64, 0.78)) {
                val x = ring.left.position + (ring.right.position - ring.left.position) * fraction
                val y = ring.top.position + (ring.bottom.position - ring.top.position) * fraction
                if (!material(ring.left.position + leftThickness * 0.90, y, probeSpan, ring.materialIsLight)) backgrounds++
                if (!material(ring.right.position - rightThickness * 0.90, y, probeSpan, ring.materialIsLight)) backgrounds++
                if (!material(x, ring.top.position + topThickness * 0.90, probeSpan, ring.materialIsLight)) backgrounds++
                if (!material(x, ring.bottom.position - bottomThickness * 0.90, probeSpan, ring.materialIsLight)) backgrounds++
                total += 4
            }
            if (backgrounds.toDouble() / total < 0.65) return null
            val minX = max(ring.left.position - leftThickness / 2, 0.0)
            val minY = max(ring.top.position - topThickness / 2, 0.0)
            val maxX = min(ring.left.position - leftThickness / 2 + outerWidth, width)
            val maxY = min(ring.top.position - topThickness / 2 + outerHeight, height)
            if (minX >= maxX || minY >= maxY) return null
            val frameLeft = floor(minX)
            val frameTop = floor(minY)
            val frameWidth = ceil(maxX) - frameLeft
            val frameHeight = ceil(maxY) - frameTop
            if (frameWidth < 16 || frameHeight < 16 || !(frameWidth < width * 0.98 || frameHeight < height * 0.98)) return null
            return image.cropped(frameLeft, frameTop, frameLeft + frameWidth, frameTop + frameHeight)
        }

        val candidateRings = ArrayList<Ring>()
        for (materialIsLight in booleanArrayOf(false, true)) {
            val lefts = candidateLines(0.0, 0.35, true, materialIsLight, true)
            val rights = candidateLines(0.65, 1.0, true, materialIsLight, false)
            val tops = candidateLines(0.0, 0.35, false, materialIsLight, true)
            val bottoms = candidateLines(0.65, 1.0, false, materialIsLight, false)
            for (left in lefts) for (right in rights) {
                if (right.position - left.position < 16) continue
                for (top in tops) for (bottom in bottoms) {
                    if (bottom.position - top.position < 16) continue
                    val crossX = left.position / width to right.position / width
                    val crossY = top.position / height to bottom.position / height
                    val scoredLeft = AxisLine(left.position, lineScore(left.position, true, materialIsLight, crossY.first, crossY.second))
                    val scoredRight = AxisLine(right.position, lineScore(right.position, true, materialIsLight, crossY.first, crossY.second))
                    val scoredTop = AxisLine(top.position, lineScore(top.position, false, materialIsLight, crossX.first, crossX.second))
                    val scoredBottom = AxisLine(bottom.position, lineScore(bottom.position, false, materialIsLight, crossX.first, crossX.second))
                    val minimumLine = minOf(scoredLeft.score, scoredRight.score, min(scoredTop.score, scoredBottom.score))
                    if (minimumLine < 0.67) continue
                    val interior = oppositeInteriorScore(Ring(scoredLeft, scoredRight, scoredTop, scoredBottom, materialIsLight, 0.0))
                    val ring = Ring(scoredLeft, scoredRight, scoredTop, scoredBottom, materialIsLight, interior)
                    if (ring.score < 0.80 || interior < 0.12) continue
                    if (!hasCornerStep(ring)) continue
                    candidateRings += ring
                }
            }
        }
        for (ring in candidateRings.sortedBy { it.area }) refinedFrame(ring)?.let { return it }
        return null
    }

    private class Corner(val id: Int, val xDirection: Double, val yDirection: Double)

    private val CORNERS = listOf(Corner(0, 1.0, 1.0), Corner(1, -1.0, 1.0), Corner(2, -1.0, -1.0), Corner(3, 1.0, -1.0))
    private val CORNER_ORIGINS = listOf(0.0 to 0.0, 1.0 to 0.0, 1.0 to 1.0, 0.0 to 1.0)
    private val FRACTION_OFFSETS = doubleArrayOf(-0.55, -0.28, 0.0, 0.28, 0.55)
    private val NEAR_EDGE_FRACTIONS = doubleArrayOf(0.25, 0.35, 0.45)
    private val FAR_EDGE_FRACTIONS = doubleArrayOf(0.55, 0.65, 0.75)

    private fun sampledMatricesCore(image: Raster, gates: Open3DPCGates): SamplingResult {
        val width = image.width.toDouble()
        val height = image.height.toDouble()
        val shortestSide = min(width, height)
        if (shortestSide < 16) return SamplingResult(emptyList(), "rectified frame too small", Open3DPCRejection.RectifiedFrameTooSmall)
        val field = ThresholdField(image, max(1.0, shortestSide / 120))
        if (field.contrast < 28) return SamplingResult(emptyList(), "frame contrast below threshold", Open3DPCRejection.FrameContrastBelowThreshold)

        val candidates = ArrayList<SampledMatrix>()
        var rejection = "candidate interior lacks opposite material"
        var rejectionReason = Open3DPCRejection.InteriorLacksOppositeMaterial
        var rejectionPriority = 0
        var deepestDiagnostics: StructuralDiagnostics? = null
        var physicalSignatureSeen = false
        fun recordRejection(detail: String, reason: Open3DPCRejection, priority: Int) {
            if (priority < rejectionPriority) return
            rejectionPriority = priority
            rejection = detail
            rejectionReason = reason
        }

        for (materialIsLight in booleanArrayOf(false, true)) {
            fun isMaterial(brightness: Double, x: Double, y: Double) = if (materialIsLight) brightness > field(x, y) else brightness < field(x, y)

            fun materialFraction(centerX: Double, centerY: Double, xRadius: Double, yRadius: Double, span: Double): Double {
                var hits = 0
                for (xOffset in FRACTION_OFFSETS) for (yOffset in FRACTION_OFFSETS) {
                    val x = centerX + xOffset * xRadius
                    val y = centerY + yOffset * yRadius
                    if (isMaterial(image.brightness(x, y, span), x, y)) hits++
                }
                return hits.toDouble() / 25
            }

            val interiorMaterial = materialFraction(width * 0.5, height * 0.5, width * 0.38, height * 0.38, max(1.0, shortestSide / 150))
            val interiorBackground = 1 - interiorMaterial
            var diagnostics = StructuralDiagnostics(interiorBackground)

            val ringProbe = max(1.0, shortestSide / 150)
            var ringMaterialFraction = 0.0
            for (depth in doubleArrayOf(0.02, 0.05, 0.08)) {
                val inset = max(1.0, shortestSide * depth)
                var hits = 0
                var count = 0
                fun probe(x: Double, y: Double) { count++; if (isMaterial(image.brightness(x, y, ringProbe), x, y)) hits++ }
                for (index in 1..9) {
                    val fraction = index.toDouble() / 10
                    probe(width * fraction, inset)
                    probe(width * fraction, height - inset)
                    probe(inset, height * fraction)
                    probe(width - inset, height * fraction)
                }
                ringMaterialFraction = max(ringMaterialFraction, hits.toDouble() / count)
            }
            if (ringMaterialFraction < 0.70) {
                deepestDiagnostics = diagnostics
                recordRejection("outer frame ring is not this polarity's material", Open3DPCRejection.PolarityRingNotMaterial, 1)
                continue
            }
            if (interiorMaterial < 0.025) {
                deepestDiagnostics = diagnostics
                recordRejection("candidate interior lacks opposite material", Open3DPCRejection.InteriorLacksOppositeMaterial, 1)
                continue
            }

            fun frameEdgeTransition(startX: Double, startY: Double, deltaX: Double, deltaY: Double, limit: Double): Double? {
                fun sample(distance: Double) = image.brightness(startX + deltaX * distance, startY + deltaY * distance, 0.0, 0)
                fun material(distance: Double) = isMaterial(sample(distance), startX + deltaX * distance, startY + deltaY * distance)
                fun threshold(distance: Double) = field(startX + deltaX * distance, startY + deltaY * distance)
                val coarseStep = max(0.5, shortestSide / 240)
                var entry = coarseStep * 0.5
                while (entry <= limit && !material(entry)) entry += coarseStep
                if (entry > limit) return null
                val skipped = entry - coarseStep * 0.5
                var lastMaterial = entry
                var distance = entry + coarseStep
                var bracketEnd: Double? = null
                while (distance <= limit) {
                    if (!material(distance)) { bracketEnd = distance; break }
                    lastMaterial = distance
                    distance += coarseStep
                }
                val end = bracketEnd ?: return null
                val fineStep = 0.5
                var previous = sample(lastMaterial)
                var fine = lastMaterial + fineStep
                while (fine < end) {
                    val current = sample(fine)
                    if (!material(fine)) {
                        val span = current - previous
                        val crossing = if (abs(span) > 0.0001) (threshold(fine) - previous) / span else 0.5
                        return fine - fineStep + min(max(crossing, 0.0), 1.0) * fineStep - skipped
                    }
                    previous = current
                    fine += fineStep
                }
                val span = sample(end) - previous
                val crossing = if (abs(span) > 0.0001) (threshold(end) - previous) / span else 0.5
                return max(fine - fineStep, lastMaterial) + min(max(crossing, 0.0), 1.0) * fineStep - skipped
            }

            fun edgeThickness(startX: Double, startY: Double, deltaX: Double, deltaY: Double): Double? {
                val alongVerticalEdge = deltaX != 0.0
                val limit = (if (alongVerticalEdge) width else height) * 0.22
                fun transitions(fractions: DoubleArray): List<Double> {
                    val output = ArrayList<Double>(fractions.size)
                    for (fraction in fractions) frameEdgeTransition(
                        if (alongVerticalEdge) startX else width * fraction,
                        if (alongVerticalEdge) height * fraction else startY,
                        deltaX, deltaY, limit,
                    )?.let { output += it }
                    return output
                }
                val near = transitions(NEAR_EDGE_FRACTIONS)
                val far = transitions(FAR_EDGE_FRACTIONS)
                if (near.size + far.size < 3) return null
                val nearMedian = median(near)
                val farMedian = median(far)
                return if (nearMedian != null && farMedian != null) min(nearMedian, farMedian) else nearMedian ?: farMedian
            }

            fun thicknessRejected() {
                deepestDiagnostics = diagnostics
                recordRejection("outer frame thickness is inconsistent", Open3DPCRejection.FrameThicknessInconsistent, 2)
            }
            val leftThickness = edgeThickness(0.0, 0.0, 1.0, 0.0)
            val rightThickness = if (leftThickness == null) null else edgeThickness(width - 1, 0.0, -1.0, 0.0)
            val topThickness = if (rightThickness == null) null else edgeThickness(0.0, 0.0, 0.0, 1.0)
            val bottomThickness = if (topThickness == null) null else edgeThickness(0.0, height - 1, 0.0, -1.0)
            if (leftThickness == null || rightThickness == null || topThickness == null || bottomThickness == null) { thicknessRejected(); continue }
            val horizontalThickness = (leftThickness + rightThickness) / 2
            val verticalThickness = (topThickness + bottomThickness) / 2
            if (horizontalThickness <= 0.5 || verticalThickness <= 0.5 || horizontalThickness > width * 0.2 || verticalThickness > height * 0.2) { thicknessRejected(); continue }
            val frameThicknessIsConsistent = abs(leftThickness - rightThickness) / horizontalThickness <= 0.25 &&
                abs(topThickness - bottomThickness) / verticalThickness <= 0.25
            if (gates.requireConsistentFrameThickness && !frameThicknessIsConsistent) { thicknessRejected(); continue }

            var measuredMx = horizontalThickness * 2
            var measuredMy = verticalThickness * 2
            val squareModuleAspectLimit = 1.12
            val moduleAgreementTolerance = 0.20
            val measuredModuleAspectRatio = max(measuredMx, measuredMy) / min(measuredMx, measuredMy)
            diagnostics = StructuralDiagnostics(interiorBackground, horizontalThickness, verticalThickness, measuredModuleAspectRatio)
            if (gates.requireSquareModules && measuredModuleAspectRatio > squareModuleAspectLimit) {
                deepestDiagnostics = diagnostics
                recordRejection("rectified M is not square (Mx/My ${String.format(java.util.Locale.ROOT, "%.2f", measuredModuleAspectRatio)})", Open3DPCRejection.ModulesNotSquare, 3)
                continue
            }

            fun cornerMaterialRun(corner: Corner, alongX: Boolean, cross: Double): Double {
                val step = max(0.5, shortestSide / 240)
                val limit = (if (alongX) width else height) * 0.6
                var distance = 0.0
                var lastMaterial = 0.0
                var backgroundRun = 0
                while (distance <= limit) {
                    val along = if ((if (alongX) corner.xDirection else corner.yDirection) > 0) distance else (if (alongX) width else height) - distance
                    val x = if (alongX) along else cross
                    val y = if (alongX) cross else along
                    if (isMaterial(image.brightness(x, y, 0.0, 0), x, y)) {
                        lastMaterial = distance
                        backgroundRun = 0
                    } else if (++backgroundRun >= 2) break
                    distance += step
                }
                return lastMaterial
            }
            val blockX = DoubleArray(4)
            val blockY = DoubleArray(4)
            for ((index, corner) in CORNERS.withIndex()) {
                val crossY = if (corner.yDirection > 0) measuredMy else height - measuredMy
                val crossX = if (corner.xDirection > 0) measuredMx else width - measuredMx
                blockX[index] = cornerMaterialRun(corner, true, crossY)
                blockY[index] = cornerMaterialRun(corner, false, crossX)
            }
            var best = 0
            for (index in 1 until 4) if (min(blockX[best], blockY[best]) < min(blockX[index], blockY[index])) best = index
            val medianOther = (0 until 4).filter { it != best }.map { min(blockX[it], blockY[it]) }.sorted()[1]
            val blockMx = blockX[best] / 1.5
            val blockMy = blockY[best] / 1.5
            if (min(blockX[best], blockY[best]) >= medianOther * 1.8 &&
                blockMx / measuredMx > 0.55 && blockMx / measuredMx < 1.9 &&
                blockMy / measuredMy > 0.55 && blockMy / measuredMy < 1.9) {
                val blockWeight = 0.9
                measuredMx = blockWeight * blockMx + (1 - blockWeight) * measuredMx
                measuredMy = blockWeight * blockMy + (1 - blockWeight) * measuredMy
            }
            val sampleSpan = min(measuredMx, measuredMy) * 0.12

            fun cornerBlockScore(corner: Corner, horizontalModule: Double, verticalModule: Double): Double {
                val markerX = if (corner.xDirection > 0) horizontalThickness else width - horizontalThickness - horizontalModule
                val markerY = if (corner.yDirection > 0) verticalThickness else height - verticalThickness - verticalModule
                return materialFraction(markerX + horizontalModule / 2, markerY + verticalModule / 2, horizontalModule * 0.34, verticalModule * 0.34, sampleSpan)
            }
            val measuredMarkerCandidates = CORNERS.filter { cornerBlockScore(it, measuredMx, measuredMy) >= 0.88 }
            if (measuredMarkerCandidates.size != 1) {
                deepestDiagnostics = diagnostics
                if (measuredMarkerCandidates.isEmpty()) recordRejection("no unique frame-attached M×M marker from inner frame guides", Open3DPCRejection.NoUniqueAttachedMarker, 3)
                else recordRejection("ambiguous frame-attached corner markers", Open3DPCRejection.AmbiguousCornerMarkers, 3)
                continue
            }
            val measuredMarker = measuredMarkerCandidates[0]
            val measuredMarkerScore = cornerBlockScore(measuredMarker, measuredMx, measuredMy)
            diagnostics = StructuralDiagnostics(interiorBackground, horizontalThickness, verticalThickness, measuredModuleAspectRatio, measuredMarkerScore)
            deepestDiagnostics = diagnostics

            val estimatedRows = swiftRound(height / measuredMy).toInt() - 2
            val estimatedColumns = swiftRound(width / measuredMx).toInt() - 2
            val geometries = ArrayList<Pair<Int, Int>>()
            for (rowOffset in -1..1) for (columnOffset in -1..1) {
                val rows = estimatedRows + rowOffset
                val columns = estimatedColumns + columnOffset
                if (!validInSomeOrientation(rows, columns)) continue
                val horizontalModule = width / (columns + 2)
                val verticalModule = height / (rows + 2)
                if (min(horizontalModule, verticalModule) < 2.5 ||
                    abs(horizontalModule / measuredMx - 1) > moduleAgreementTolerance ||
                    abs(verticalModule / measuredMy - 1) > moduleAgreementTolerance) continue
                geometries += rows to columns
            }
            if (geometries.isEmpty()) {
                deepestDiagnostics = diagnostics
                recordRejection("frame scale does not fit a protocol-valid grid", Open3DPCRejection.NoProtocolValidGrid, 5)
                continue
            }

            for ((rows, columns) in geometries) {
                val horizontalModule = width / (columns + 2)
                val verticalModule = height / (rows + 2)
                val moduleAspectRatio = max(horizontalModule, verticalModule) / min(horizontalModule, verticalModule)
                if (gates.requireSquareModules && moduleAspectRatio > squareModuleAspectLimit) {
                    recordRejection("grid modules are not square (Mx/My ${String.format(java.util.Locale.ROOT, "%.2f", moduleAspectRatio)})", Open3DPCRejection.ModulesNotSquare, 5)
                    continue
                }
                val markerCandidates = CORNERS.filter { cornerBlockScore(it, horizontalModule, verticalModule) >= 0.88 }
                if (markerCandidates.size != 1 || markerCandidates[0].id != measuredMarker.id) {
                    recordRejection("corner marker does not agree with measured frame scale", Open3DPCRejection.MarkerDisagreesWithScale, 5)
                    continue
                }
                val marker = markerCandidates[0]
                val markerScore = cornerBlockScore(marker, horizontalModule, verticalModule)
                val markerRow = if (marker.yDirection > 0) 0 else rows - 1
                val markerColumn = if (marker.xDirection > 0) 0 else columns - 1
                fun pointX(xInset: Double) = if (marker.xDirection > 0) xInset else width - xInset
                fun pointY(yInset: Double) = if (marker.yDirection > 0) yInset else height - yInset

                var frameHits = 0
                var frameTotal = 0
                fun frameProbe(x: Double, y: Double) { frameTotal++; if (isMaterial(image.brightness(x, y, sampleSpan), x, y)) frameHits++ }
                for (index in 1..18) {
                    val x = width * index / 19
                    val y = height * index / 19
                    frameProbe(x, verticalModule * 0.25)
                    frameProbe(x, height - verticalModule * 0.25)
                    frameProbe(horizontalModule * 0.25, y)
                    frameProbe(width - horizontalModule * 0.25, y)
                }
                val frameScore = frameHits.toDouble() / frameTotal
                if (gates.requireOuterFrameContinuity && frameScore < 0.76) {
                    recordRejection("outer frame continuity ${swiftRound(frameScore * 100).toInt()}%", Open3DPCRejection.OuterFrameDiscontinuous, 2)
                    continue
                }
                physicalSignatureSeen = true

                val quietPoints = arrayListOf(
                    pointX(1.75 * horizontalModule) to pointY(verticalModule),
                    pointX(horizontalModule) to pointY(1.75 * verticalModule),
                    pointX(1.75 * horizontalModule) to pointY(1.75 * verticalModule),
                )
                val markerQuietBandIsClear = quietPoints.all { !isMaterial(image.brightness(it.first, it.second, sampleSpan), it.first, it.second) }
                if (gates.requireMarkerQuietBand && !markerQuietBandIsClear) {
                    recordRejection("marker-to-module M/2 background band missing", Open3DPCRejection.MarkerQuietBandMissing, 3)
                    continue
                }
                for (row in 0 until rows) for (column in 0 until columns) {
                    if (row == markerRow && column == markerColumn) continue
                    val centerX = (column + 1.5) * horizontalModule
                    val centerY = (row + 1.5) * verticalModule
                    if (column == 0) quietPoints += 0.75 * horizontalModule to centerY
                    if (column == columns - 1) quietPoints += width - 0.75 * horizontalModule to centerY
                    if (row == 0) quietPoints += centerX to 0.75 * verticalModule
                    if (row == rows - 1) quietPoints += centerX to height - 0.75 * verticalModule
                }
                val quietHits = quietPoints.count { !isMaterial(image.brightness(it.first, it.second, sampleSpan), it.first, it.second) }
                val quietScore = quietHits.toDouble() / quietPoints.size
                if (gates.requireModuleQuietBands && quietScore < 0.84) {
                    recordRejection("M/2 background band missing ${swiftRound(quietScore * 100).toInt()}%", Open3DPCRejection.ModuleQuietBandMissing, 3)
                    continue
                }

                val sampled = ArrayList<String>(rows)
                var lowestConfidence = 1.0
                for (row in 0 until rows) {
                    val values = StringBuilder(columns)
                    for (column in 0 until columns) {
                        if (row == markerRow && column == markerColumn) { values.append('O'); continue }
                        val fraction = materialFraction((column + 1.5) * horizontalModule, (row + 1.5) * verticalModule, horizontalModule * 0.30, verticalModule * 0.30, sampleSpan)
                        lowestConfidence = min(lowestConfidence, abs(fraction - 0.5) * 2)
                        values.append(if (fraction >= 0.5) '1' else '0')
                    }
                    sampled += values.toString()
                }
                if (lowestConfidence < 0.30) {
                    recordRejection("ambiguous cell confidence ${swiftRound(lowestConfidence * 100).toInt()}%", Open3DPCRejection.AmbiguousCellConfidence, 4)
                    continue
                }
                val structuralScore = 0.45 * frameScore + 0.25 * markerScore + 0.20 * quietScore + 0.10 * lowestConfidence
                candidates += SampledMatrix(
                    sampled, rows, columns, frameScore, horizontalModule, verticalModule, markerScore, quietScore, lowestConfidence,
                    StructuralDiagnostics(interiorBackground, horizontalThickness, verticalThickness, moduleAspectRatio, markerScore), structuralScore,
                )
            }
        }
        val ranked = candidates.sortedByDescending { it.structuralScore }
        val best = ranked.firstOrNull() ?: return SamplingResult(emptyList(), rejection, rejectionReason, deepestDiagnostics, physicalSignatureSeen)
        val runnerUp = ranked.getOrNull(1)
        if (runnerUp != null && (runnerUp.rows != best.rows || runnerUp.columns != best.columns) && best.structuralScore - runnerUp.structuralScore < 0.06) {
            if (best.lowestCellConfidence - runnerUp.lowestCellConfidence < CELL_CONFIDENCE_TIE_BREAK) {
                return SamplingResult(emptyList(), "ambiguous geometry hypotheses ${best.rows}×${best.columns} / ${runnerUp.rows}×${runnerUp.columns}",
                    Open3DPCRejection.AmbiguousGeometry, best.diagnostics, true)
            }
        }
        return SamplingResult(listOf(best), "", Open3DPCRejection.None, best.diagnostics, true)
    }
}
