// Copyright 2026 Roman Simonov. Licensed under the Apache License, Version 2.0.

package io.github.romanaerl.open3dpc

import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * Finds the quadrilaterals a code could be, without a vision library.
 *
 * A code's frame is one closed loop, so it is one connected region under a local threshold, whichever
 * way round its colours are. Each region's silhouette is reduced to its convex hull, which a notch or
 * the marker cannot dent; the hull to four sides; each side to a line fitted through the silhouette
 * away from the corners, because a printed corner is round and its line is not. Thresholds are
 * local, so a shadow across a tab does not cut it in two, and a proposal is only a neighbourhood:
 * every later stage of the decoder checks what it is given.
 *
 * Not thread-safe: the buffers are kept between frames.
 */
internal class ContourQuads(
    private val minimumSize: Double,
    private val maximumObservations: Int,
    private val quadratureTolerance: Double,
    private val radiusDivisor: Int,
    private val globalPass: Boolean,
    private val minimumAspect: Double = 0.08,
    private val workSide: Int = 480,
    private val thresholdOffset: Int = 4,
) : QuadProposalGenerator {
    private var gray = ByteArray(0)
    private var integral = IntArray(0)
    private var labels = IntArray(0)
    private var parents = IntArray(0)
    private var boxes = IntArray(0)
    private var slots = IntArray(0)
    private var rootList = IntArray(0)

    override fun proposals(frame: Open3DPCFrame, roi: FrameRect): List<List<ScanPoint>> {
        val left = max(floor(roi.left).toInt(), 0)
        val top = max(floor(roi.top).toInt(), 0)
        val right = min(ceil(roi.right).toInt(), frame.width)
        val bottom = min(ceil(roi.bottom).toInt(), frame.height)
        if (right - left < 16 || bottom - top < 16) return emptyList()
        val factor = max(1, min(right - left, bottom - top) / workSide)
        val width = (right - left) / factor
        val height = (bottom - top) / factor
        downscale(frame, left, top, factor, width, height)
        val found = ArrayList<Proposal>()
        val minimumSide = floor(min(width, height) * minimumSize).toInt().coerceAtLeast(6)
        threshold(width, height)
        for (region in regions(width, height, minimumSide)) quad(region, width, height)?.let { found += it }
        if (globalPass) {
            globalThreshold(width, height)
            for (region in regions(width, height, minimumSide)) quad(region, width, height)?.let { found += it }
        }
        found.sortByDescending { it.score }
        val kept = ArrayList<Proposal>()
        for (proposal in found) {
            if (kept.size == maximumObservations) break
            if (kept.none { sameQuad(it.corners, proposal.corners) }) kept += proposal
        }
        return kept.map { proposal -> proposal.corners.map { ScanPoint((it.x + 0.5).toFloat() * factor - 0.5f + left, (it.y + 0.5).toFloat() * factor - 0.5f + top) } }
    }

    private fun downscale(frame: Open3DPCFrame, left: Int, top: Int, factor: Int, width: Int, height: Int) {
        if (gray.size < width * height) gray = ByteArray(width * height)
        val area = factor * factor
        for (y in 0 until height) for (x in 0 until width) {
            var total = 0
            for (row in 0 until factor) {
                val offset = (top + y * factor + row) * frame.rowStride + left + x * factor
                for (column in 0 until factor) total += frame.luma[offset + column].toInt() and 255
            }
            gray[y * width + x] = (total / area).toByte()
        }
    }

    /** `labels`: 0 background of the mask, 1 darker than its neighbourhood, 2 lighter. */
    private fun threshold(width: Int, height: Int) {
        val size = (width + 1) * (height + 1)
        if (integral.size < size) integral = IntArray(size)
        if (labels.size < width * height) labels = IntArray(width * height)
        for (y in 0 until height) {
            var row = 0
            for (x in 0 until width) {
                row += gray[y * width + x].toInt() and 255
                integral[(y + 1) * (width + 1) + x + 1] = integral[y * (width + 1) + x + 1] + row
            }
        }
        val radius = max(7, min(width, height) / radiusDivisor)
        for (y in 0 until height) {
            val y0 = max(y - radius, 0)
            val y1 = min(y + radius + 1, height)
            for (x in 0 until width) {
                val x0 = max(x - radius, 0)
                val x1 = min(x + radius + 1, width)
                val sum = integral[y1 * (width + 1) + x1] - integral[y0 * (width + 1) + x1] - integral[y1 * (width + 1) + x0] + integral[y0 * (width + 1) + x0]
                val area = (x1 - x0) * (y1 - y0)
                val value = (gray[y * width + x].toInt() and 255) * area
                labels[y * width + x] = if (value < sum - thresholdOffset * area) 1 else if (value > sum + thresholdOffset * area) 2 else 0
            }
        }
    }

    /** Otsu over the crop: on a code that fills it, the two materials are the two populations. */
    private fun globalThreshold(width: Int, height: Int) {
        val histogram = IntArray(256)
        val count = width * height
        for (index in 0 until count) histogram[gray[index].toInt() and 255]++
        var total = 0.0
        for (level in 0 until 256) total += level.toDouble() * histogram[level]
        var below = 0
        var sumBelow = 0.0
        var best = 0.0
        var split = 128
        for (level in 0 until 256) {
            below += histogram[level]
            if (below == 0 || below == count) continue
            sumBelow += level.toDouble() * histogram[level]
            val difference = sumBelow / below - (total - sumBelow) / (count - below)
            val between = below.toDouble() * (count - below) * difference * difference
            if (between > best) { best = between; split = level }
        }
        for (index in 0 until count) labels[index] = if ((gray[index].toInt() and 255) <= split) 1 else 2
    }

    private fun find(index: Int): Int {
        var node = index
        while (parents[node] != node) { parents[node] = parents[parents[node]]; node = parents[node] }
        return node
    }

    private fun join(index: Int, other: Int) {
        val a = find(index)
        val b = find(other)
        if (a != b) parents[max(a, b)] = min(a, b)
    }

    /** One region's silhouette: the first and last pixel of every row and column of its box. */
    private class Region(val minX: Int, val minY: Int, val maxX: Int, val maxY: Int) {
        val rowFirst = IntArray(maxY - minY + 1) { -1 }
        val rowLast = IntArray(maxY - minY + 1)
        val columnFirst = IntArray(maxX - minX + 1) { -1 }
        val columnLast = IntArray(maxX - minX + 1)
    }

    /**
     * Union-find, 8-connected: a thin frame on a slant touches itself only at corners. One pass joins,
     * one measures every root's box, one fills the silhouettes of the regions worth a look, so the
     * cost is the frame's and not the frame's times its regions'.
     */
    private fun regions(width: Int, height: Int, minimumSide: Int): List<Region> {
        val size = width * height
        if (parents.size < size) { parents = IntArray(size); boxes = IntArray(size * 4); slots = IntArray(size); rootList = IntArray(size) }
        for (y in 0 until height) for (x in 0 until width) {
            val index = y * width + x
            val mask = labels[index]
            parents[index] = index
            if (mask == 0) continue
            // Whichever neighbour matches, what it touches was joined when it was visited: one
            // look upward settles most pixels, and that is what keeps this linear on a noisy mask.
            val north = y > 0 && labels[index - width] == mask
            if (north) { parents[index] = find(index - width); continue }
            val west = x > 0 && labels[index - 1] == mask
            val northEast = y > 0 && x < width - 1 && labels[index - width + 1] == mask
            val northWest = !west && y > 0 && x > 0 && labels[index - width - 1] == mask
            if (west) parents[index] = find(index - 1) else if (northWest) parents[index] = find(index - width - 1)
            if (northEast) { if (west || northWest) join(index, index - width + 1) else parents[index] = find(index - width + 1) }
        }
        var count = 0
        for (index in 0 until size) {
            if (labels[index] == 0) continue
            val root = find(index)
            val x = index % width
            val y = index / width
            if (root == index) {
                boxes[index * 4] = x; boxes[index * 4 + 1] = y; boxes[index * 4 + 2] = x; boxes[index * 4 + 3] = y
                rootList[count++] = index
            } else {
                val at = root * 4
                if (x < boxes[at]) boxes[at] = x
                if (x > boxes[at + 2]) boxes[at + 2] = x
                boxes[at + 3] = y
            }
        }
        val kept = (0 until count).map { rootList[it] }.filter {
            val w = boxes[it * 4 + 2] - boxes[it * 4] + 1
            val h = boxes[it * 4 + 3] - boxes[it * 4 + 1] + 1
            max(w, h) >= minimumSide && min(w, h) >= 3 && !(w >= width - 1 && h >= height - 1)
        }.sortedByDescending { (boxes[it * 4 + 2] - boxes[it * 4] + 1) * (boxes[it * 4 + 3] - boxes[it * 4 + 1] + 1) }.take(MAXIMUM_REGIONS)
        java.util.Arrays.fill(slots, 0, size, -1)
        val regions = ArrayList<Region>(kept.size)
        for ((slot, root) in kept.withIndex()) {
            slots[root] = slot
            regions += Region(boxes[root * 4], boxes[root * 4 + 1], boxes[root * 4 + 2], boxes[root * 4 + 3])
        }
        for (y in 0 until height) for (x in 0 until width) {
            val index = y * width + x
            if (labels[index] == 0) continue
            val slot = slots[find(index)]
            if (slot < 0) continue
            val region = regions[slot]
            val row = y - region.minY
            val column = x - region.minX
            if (region.rowFirst[row] < 0) region.rowFirst[row] = x
            region.rowLast[row] = x
            if (region.columnFirst[column] < 0) region.columnFirst[column] = y
            region.columnLast[column] = y
        }
        return regions
    }

    private class Proposal(val corners: List<FramePoint>, val score: Double)

    private fun quad(region: Region, width: Int, height: Int): Proposal? {
        val outline = ArrayList<FramePoint>((region.rowFirst.size + region.columnFirst.size) * 2)
        for (row in region.rowFirst.indices) if (region.rowFirst[row] >= 0) {
            outline += FramePoint(region.rowFirst[row].toDouble(), (row + region.minY).toDouble())
            outline += FramePoint(region.rowLast[row].toDouble(), (row + region.minY).toDouble())
        }
        val hull = convexHull(outline)
        for (column in region.columnFirst.indices) if (region.columnFirst[column] >= 0) {
            outline += FramePoint((column + region.minX).toDouble(), region.columnFirst[column].toDouble())
            outline += FramePoint((column + region.minX).toDouble(), region.columnLast[column].toDouble())
        }
        if (hull.size < 4) return null
        val hullArea = area(hull)
        val corners = fittedSides(outline, fourSides(hull)) ?: return null
        val quadArea = area(corners)
        if (quadArea <= 0) return null
        val fill = min(quadArea, hullArea) / max(quadArea, hullArea)
        if (fill < 0.82) return null
        val sides = List(4) { Perspective.distance(corners[it], corners[(it + 1) % 4]) }
        val shortest = sides.min()
        val longest = sides.max()
        if (shortest < min(width, height) * minimumSize || shortest / longest < minimumAspect) return null
        val horizontal = (sides[0] + sides[2]) / 2
        val vertical = (sides[1] + sides[3]) / 2
        if (min(horizontal, vertical) / max(horizontal, vertical) < minimumAspect) return null
        var worst = 0.0
        for (index in 0 until 4) worst = max(worst, abs(angle(corners[(index + 3) % 4], corners[index], corners[(index + 1) % 4]) - 90))
        if (worst > quadratureTolerance) return null
        for (point in corners) if (point.x < -2 || point.y < -2 || point.x > width + 1 || point.y > height + 1) return null
        return Proposal(topLeftFirst(corners), fill * (1 - worst / 180) * quadArea)
    }

    private fun angle(a: FramePoint, b: FramePoint, c: FramePoint): Double {
        val ux = a.x - b.x
        val uy = a.y - b.y
        val vx = c.x - b.x
        val vy = c.y - b.y
        val cosine = (ux * vx + uy * vy) / (hypot(ux, uy) * hypot(vx, vy))
        return Math.toDegrees(acos(cosine.coerceIn(-1.0, 1.0)))
    }

    private fun cross(o: FramePoint, a: FramePoint, b: FramePoint) = (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)

    /** Andrew's chain. The points arrive sorted by row, then column: first and last of each row, in order. */
    private fun convexHull(points: List<FramePoint>): List<FramePoint> {
        val hull = ArrayList<FramePoint>()
        for (point in points) {
            while (hull.size >= 2 && cross(hull[hull.size - 2], hull[hull.size - 1], point) <= 0) hull.removeAt(hull.size - 1)
            hull += point
        }
        val lower = hull.size + 1
        for (index in points.size - 2 downTo 0) {
            while (hull.size >= lower && cross(hull[hull.size - 2], hull[hull.size - 1], points[index]) <= 0) hull.removeAt(hull.size - 1)
            hull += points[index]
        }
        hull.removeAt(hull.size - 1)
        return hull
    }

    private fun area(polygon: List<FramePoint>): Double {
        var total = 0.0
        for (index in polygon.indices) {
            val a = polygon[index]
            val b = polygon[(index + 1) % polygon.size]
            total += a.x * b.y - b.x * a.y
        }
        return abs(total) / 2
    }

    /**
     * Four sides of a convex polygon: the vertex that costs the least area goes first, and it is
     * replaced by where its neighbouring edges would meet, so a cut corner is grown back rather than
     * chopped off further.
     */
    private fun fourSides(hull: List<FramePoint>): List<FramePoint> {
        val polygon = ArrayList(hull)
        while (polygon.size > 4) {
            var bestIndex = -1
            var bestCost = Double.MAX_VALUE
            var bestPoint: FramePoint? = null
            val size = polygon.size
            for (index in 0 until size) {
                val before = polygon[(index + size - 1) % size]
                val a = polygon[index]
                val b = polygon[(index + 1) % size]
                val after = polygon[(index + 2) % size]
                val meet = intersection(before, a, b, after) ?: continue
                val cost = abs(cross(a, meet, b))
                if (cost < bestCost) { bestCost = cost; bestIndex = index; bestPoint = meet }
            }
            if (bestIndex < 0) return polygon.subList(0, 4).toList()
            polygon[bestIndex] = bestPoint!!
            polygon.removeAt((bestIndex + 1) % size)
        }
        return polygon
    }

    private fun intersection(a: FramePoint, b: FramePoint, c: FramePoint, d: FramePoint): FramePoint? {
        val ux = b.x - a.x
        val uy = b.y - a.y
        val vx = d.x - c.x
        val vy = d.y - c.y
        val denominator = ux * vy - uy * vx
        if (abs(denominator) < 1e-6) return null
        val t = ((c.x - a.x) * vy - (c.y - a.y) * vx) / denominator
        return FramePoint(a.x + ux * t, a.y + uy * t)
    }

    /** Each side refitted through the outline points beside its middle; the corners are where they meet. */
    private fun fittedSides(outline: List<FramePoint>, quad: List<FramePoint>): List<FramePoint>? {
        if (quad.size != 4) return null
        val lines = ArrayList<Pair<FramePoint, FramePoint>>(4)
        for (index in 0 until 4) {
            var a = quad[index]
            var b = quad[(index + 1) % 4]
            for (tolerance in doubleArrayOf(3.0, 1.5)) {
                val fit = fitLine(outline, a, b, tolerance) ?: break
                a = fit.first; b = fit.second
            }
            lines += a to b
        }
        return List(4) { index ->
            val before = lines[(index + 3) % 4]
            val after = lines[index]
            intersection(before.first, before.second, after.first, after.second) ?: return null
        }
    }

    private fun fitLine(outline: List<FramePoint>, a: FramePoint, b: FramePoint, tolerance: Double): Pair<FramePoint, FramePoint>? {
        val length = hypot(b.x - a.x, b.y - a.y)
        if (length < 3) return null
        val ux = (b.x - a.x) / length
        val uy = (b.y - a.y) / length
        var count = 0
        var sumX = 0.0
        var sumY = 0.0
        var xx = 0.0
        var xy = 0.0
        var yy = 0.0
        val range = 0.12 * length..0.88 * length
        for (point in outline) {
            val dx = point.x - a.x
            val dy = point.y - a.y
            if (dx * ux + dy * uy !in range || abs(dy * ux - dx * uy) > tolerance) continue
            count++
            sumX += point.x; sumY += point.y
            xx += point.x * point.x; xy += point.x * point.y; yy += point.y * point.y
        }
        if (count < 4) return null
        val meanX = sumX / count
        val meanY = sumY / count
        val cxx = xx / count - meanX * meanX
        val cxy = xy / count - meanX * meanY
        val cyy = yy / count - meanY * meanY
        // The principal axis of the scatter: total least squares, so a near-vertical side is not special.
        val theta = 0.5 * kotlin.math.atan2(2 * cxy, cxx - cyy)
        val dirX = kotlin.math.cos(theta)
        val dirY = kotlin.math.sin(theta)
        return FramePoint(meanX, meanY) to FramePoint(meanX + dirX * length * if (dirX * ux + dirY * uy >= 0) 1 else -1, meanY + dirY * length * if (dirX * ux + dirY * uy >= 0) 1 else -1)
    }

    /** Clockwise on screen, from the corner nearest the top left; the order both readers use. */
    private fun topLeftFirst(corners: List<FramePoint>): List<FramePoint> {
        val centreX = corners.sumOf { it.x } / 4
        val centreY = corners.sumOf { it.y } / 4
        val clockwise = corners.sortedBy { kotlin.math.atan2(it.y - centreY, it.x - centreX) }
        val start = clockwise.indices.minByOrNull { clockwise[it].x + clockwise[it].y }!!
        return List(4) { clockwise[(start + it) % 4] }
    }

    private fun sameQuad(a: List<FramePoint>, b: List<FramePoint>): Boolean {
        val tolerance = min(Perspective.distance(a[0], a[1]), Perspective.distance(a[1], a[2])) * 0.04
        return a.indices.all { Perspective.distance(a[it], b[it]) <= tolerance }
    }

    companion object {
        private const val MAXIMUM_REGIONS = 96
        /**
         * The two requests of `Open3DPCFrameDecoder.swift`. The window of the coarse pass is small
         * because a code is small in a frame; in a wide crop the code fills it, and there the two
         * materials are also the two populations of the whole crop.
         */
        fun coarse() = ContourQuads(0.045, 48, 35.0, radiusDivisor = 20, globalPass = false)
        fun second() = ContourQuads(0.06, 5, 18.0, radiusDivisor = 9, globalPass = true)
    }
}
