// Copyright 2026 Roman Simonov. Licensed under the Apache License, Version 2.0.

import CoreGraphics
import Foundation

/// Finds the quadrilaterals a code could be, without a vision framework: the same search as
/// `ContourQuads.kt`, with the same constants.
///
/// A code's frame is one closed loop, so it is one connected region under a local threshold, whichever
/// way round its colours are. Each region's silhouette is reduced to its convex hull, which a notch or
/// the marker cannot dent; the hull to four sides; each side to a line fitted through the silhouette
/// away from the corners, because a printed corner is round and its line is not. A proposal is only a
/// neighbourhood: every later stage of the decoder checks what it is given.
///
/// Vision's rectangle sits 0.2 to 0.4 modules outside the frame of a small code, where the corner-step
/// check looks at the margin and refuses the code; these lie on the frame.
///
/// Points are pixels, origin at the top left. Not thread-safe: the buffers are kept between frames.
final class ContourQuads {
    private let minimumSize: Double
    private let maximumObservations: Int
    private let quadratureTolerance: Double
    private let radiusDivisor: Int
    private let globalPass: Bool
    private let minimumAspect = 0.08
    private let workSide = 480
    private let thresholdOffset = 4
    private let maximumRegions = 96

    private var gray: [UInt8] = []
    /// 0 background of the mask, 1 darker than its neighbourhood, 2 lighter.
    private var labels: [UInt8] = []
    private var parents: [Int32] = []
    private var boxes: [Int32] = []
    private var slots: [Int32] = []
    private var integral: [Int32] = []

    private init(
        minimumSize: Double, maximumObservations: Int, quadratureTolerance: Double, radiusDivisor: Int, globalPass: Bool
    ) {
        self.minimumSize = minimumSize
        self.maximumObservations = maximumObservations
        self.quadratureTolerance = quadratureTolerance
        self.radiusDivisor = radiusDivisor
        self.globalPass = globalPass
    }

    /// The window of the coarse pass is small because a code is small in a frame; in a wide crop the
    /// code fills it, and there the two materials are also the two populations of the whole crop.
    static func coarse() -> ContourQuads {
        .init(minimumSize: 0.045, maximumObservations: 48, quadratureTolerance: 35, radiusDivisor: 20, globalPass: false)
    }
    static func second() -> ContourQuads {
        .init(minimumSize: 0.06, maximumObservations: 5, quadratureTolerance: 18, radiusDivisor: 9, globalPass: true)
    }

    /// - Parameters:
    ///   - luma: full or video range luma, top row first.
    ///   - region: the part to search, in pixels.
    /// - Returns: quadrilaterals, best first; each clockwise on screen from the corner nearest the top left.
    func proposals(
        luma: UnsafePointer<UInt8>, width frameWidth: Int, height frameHeight: Int, bytesPerRow: Int, region: CGRect
    ) -> [[CGPoint]] {
        let left = max(Int(region.minX.rounded(.down)), 0), top = max(Int(region.minY.rounded(.down)), 0)
        let right = min(Int(region.maxX.rounded(.up)), frameWidth), bottom = min(Int(region.maxY.rounded(.up)), frameHeight)
        guard right - left >= 16, bottom - top >= 16 else { return [] }
        let factor = max(1, min(right - left, bottom - top) / workSide)
        let width = (right - left) / factor, height = (bottom - top) / factor
        reserve(width, height)
        downscale(luma + top * bytesPerRow + left, bytesPerRow, factor, width, height)

        let minimumSide = max(Int((Double(min(width, height)) * minimumSize).rounded(.down)), 6)
        var found: [(corners: [CGPoint], score: Double)] = []
        threshold(width, height)
        found += regions(width, height, minimumSide).compactMap { quad($0, width, height) }
        if globalPass {
            globalThreshold(width * height)
            found += regions(width, height, minimumSide).compactMap { quad($0, width, height) }
        }
        var kept: [[CGPoint]] = []
        for (corners, _) in found.sorted(by: { $0.score > $1.score }) {
            if kept.count == maximumObservations { break }
            if !kept.contains(where: { Self.same($0, corners) }) { kept.append(corners) }
        }
        let scale = CGFloat(factor)
        return kept.map { corners in
            corners.map {
                CGPoint(x: ($0.x + 0.5) * scale - 0.5 + CGFloat(left), y: ($0.y + 0.5) * scale - 0.5 + CGFloat(top))
            }
        }
    }

    private func reserve(_ width: Int, _ height: Int) {
        let size = width * height
        if gray.count < size {
            gray = Array(repeating: 0, count: size)
            labels = gray
            parents = Array(repeating: 0, count: size)
            slots = parents
            boxes = Array(repeating: 0, count: size * 4)
        }
        if integral.count < (width + 1) * (height + 1) { integral = Array(repeating: 0, count: (width + 1) * (height + 1)) }
    }

    private func downscale(_ luma: UnsafePointer<UInt8>, _ bytesPerRow: Int, _ factor: Int, _ width: Int, _ height: Int) {
        let area = factor * factor
        gray.withUnsafeMutableBufferPointer { gray in
            for y in 0..<height {
                for x in 0..<width {
                    var total = 0
                    for row in 0..<factor {
                        let offset = (y * factor + row) * bytesPerRow + x * factor
                        for column in 0..<factor { total += Int(luma[offset + column]) }
                    }
                    gray[y * width + x] = UInt8(total / area)
                }
            }
        }
    }

    private func threshold(_ width: Int, _ height: Int) {
        let stride = width + 1, radius = max(7, min(width, height) / radiusDivisor), offset = thresholdOffset
        integral.withUnsafeMutableBufferPointer { integral in
            gray.withUnsafeBufferPointer { gray in
                labels.withUnsafeMutableBufferPointer { labels in
                    // The buffer is reused at other widths: its zero row and column have to be zero again.
                    for x in 0...width { integral[x] = 0 }
                    for y in 0..<height {
                        var row: Int32 = 0
                        integral[(y + 1) * stride] = 0
                        for x in 0..<width {
                            row += Int32(gray[y * width + x])
                            integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row
                        }
                    }
                    for y in 0..<height {
                        let y0 = max(y - radius, 0), y1 = min(y + radius + 1, height)
                        for x in 0..<width {
                            let x0 = max(x - radius, 0), x1 = min(x + radius + 1, width)
                            let sum = Int(integral[y1 * stride + x1] - integral[y0 * stride + x1]
                                - integral[y1 * stride + x0] + integral[y0 * stride + x0])
                            let area = (x1 - x0) * (y1 - y0), value = Int(gray[y * width + x]) * area
                            labels[y * width + x] = value < sum - offset * area ? 1 : value > sum + offset * area ? 2 : 0
                        }
                    }
                }
            }
        }
    }

    /// Otsu over the crop: on a code that fills it, the two materials are the two populations.
    private func globalThreshold(_ count: Int) {
        var histogram = [Int](repeating: 0, count: 256)
        gray.withUnsafeBufferPointer { gray in for index in 0..<count { histogram[Int(gray[index])] += 1 } }
        let total = histogram.indices.reduce(0.0) { $0 + Double($1 * histogram[$1]) }
        var below = 0, sumBelow = 0.0, best = 0.0, split = 128
        for level in 0..<256 {
            below += histogram[level]
            if below == 0 || below == count { continue }
            sumBelow += Double(level * histogram[level])
            let difference = sumBelow / Double(below) - (total - sumBelow) / Double(count - below)
            let between = Double(below) * Double(count - below) * difference * difference
            if between > best { best = between; split = level }
        }
        for index in 0..<count { labels[index] = Int(gray[index]) <= split ? 1 : 2 }
    }

    /// One region's silhouette: the first and last pixel of every row and column of its box.
    private struct Region {
        let minX: Int, minY: Int
        var rowFirst: [Int32], rowLast: [Int32], columnFirst: [Int32], columnLast: [Int32]
    }

    /// Union-find, 8-connected: a thin frame on a slant touches itself only at corners. One pass joins,
    /// one measures every root's box, one fills the silhouettes of the regions worth a look.
    private func regions(_ width: Int, _ height: Int, _ minimumSide: Int) -> [Region] {
        let size = width * height
        var regions: [Region] = []
        labels.withUnsafeBufferPointer { labels in
            parents.withUnsafeMutableBufferPointer { parents in
                boxes.withUnsafeMutableBufferPointer { boxes in
                    slots.withUnsafeMutableBufferPointer { slots in
                        @inline(__always) func find(_ index: Int) -> Int {
                            var node = index
                            while Int(parents[node]) != node {
                                parents[node] = parents[Int(parents[node])]
                                node = Int(parents[node])
                            }
                            return node
                        }
                        for y in 0..<height {
                            for x in 0..<width {
                                let index = y * width + x, mask = labels[index]
                                parents[index] = Int32(index)
                                if mask == 0 { continue }
                                // Whichever neighbour matches, what it touches was joined when it was visited.
                                if y > 0, labels[index - width] == mask {
                                    parents[index] = Int32(find(index - width))
                                    continue
                                }
                                let west = x > 0 && labels[index - 1] == mask
                                let northEast = y > 0 && x < width - 1 && labels[index - width + 1] == mask
                                let northWest = !west && y > 0 && x > 0 && labels[index - width - 1] == mask
                                if west { parents[index] = Int32(find(index - 1)) }
                                else if northWest { parents[index] = Int32(find(index - width - 1)) }
                                guard northEast else { continue }
                                if west || northWest {
                                    let a = find(index), b = find(index - width + 1)
                                    if a != b { parents[max(a, b)] = Int32(min(a, b)) }
                                } else {
                                    parents[index] = Int32(find(index - width + 1))
                                }
                            }
                        }
                        var roots: [Int] = []
                        for y in 0..<height {
                            for x in 0..<width {
                                let index = y * width + x
                                if labels[index] == 0 { continue }
                                let root = find(index), at = root * 4
                                if root == index {
                                    boxes[at] = Int32(x); boxes[at + 1] = Int32(y); boxes[at + 2] = Int32(x); boxes[at + 3] = Int32(y)
                                    roots.append(root)
                                } else {
                                    if x < boxes[at] { boxes[at] = Int32(x) }
                                    if x > boxes[at + 2] { boxes[at + 2] = Int32(x) }
                                    boxes[at + 3] = Int32(y)
                                }
                            }
                        }
                        var kept: [(root: Int, width: Int, height: Int)] = []
                        for root in roots {
                            let w = Int(boxes[root * 4 + 2] - boxes[root * 4]) + 1
                            let h = Int(boxes[root * 4 + 3] - boxes[root * 4 + 1]) + 1
                            if max(w, h) >= minimumSide, min(w, h) >= 3, !(w >= width - 1 && h >= height - 1) { kept.append((root, w, h)) }
                        }
                        // Ties keep scan order, as the Kotlin reader's stable sort does.
                        kept.sort {
                            let a = $0.width * $0.height, b = $1.width * $1.height
                            return a != b ? a > b : $0.root < $1.root
                        }
                        for index in 0..<size { slots[index] = -1 }
                        for (slot, item) in kept.prefix(maximumRegions).enumerated() {
                            slots[item.root] = Int32(slot)
                            regions.append(Region(
                                minX: Int(boxes[item.root * 4]), minY: Int(boxes[item.root * 4 + 1]),
                                rowFirst: Array(repeating: -1, count: item.height), rowLast: Array(repeating: 0, count: item.height),
                                columnFirst: Array(repeating: -1, count: item.width), columnLast: Array(repeating: 0, count: item.width)
                            ))
                        }
                        regions.withUnsafeMutableBufferPointer { regions in
                            for y in 0..<height {
                                for x in 0..<width {
                                    let index = y * width + x
                                    if labels[index] == 0 { continue }
                                    let slot = Int(slots[find(index)])
                                    if slot < 0 { continue }
                                    let row = y - regions[slot].minY, column = x - regions[slot].minX
                                    if regions[slot].rowFirst[row] < 0 { regions[slot].rowFirst[row] = Int32(x) }
                                    regions[slot].rowLast[row] = Int32(x)
                                    if regions[slot].columnFirst[column] < 0 { regions[slot].columnFirst[column] = Int32(y) }
                                    regions[slot].columnLast[column] = Int32(y)
                                }
                            }
                        }
                    }
                }
            }
        }
        return regions
    }

    private func quad(_ region: Region, _ width: Int, _ height: Int) -> (corners: [CGPoint], score: Double)? {
        var outline: [CGPoint] = []
        outline.reserveCapacity((region.rowFirst.count + region.columnFirst.count) * 2)
        for row in region.rowFirst.indices where region.rowFirst[row] >= 0 {
            outline.append(CGPoint(x: Int(region.rowFirst[row]), y: row + region.minY))
            outline.append(CGPoint(x: Int(region.rowLast[row]), y: row + region.minY))
        }
        let hull = Self.convexHull(outline)
        guard hull.count >= 4 else { return nil }
        for column in region.columnFirst.indices where region.columnFirst[column] >= 0 {
            outline.append(CGPoint(x: column + region.minX, y: Int(region.columnFirst[column])))
            outline.append(CGPoint(x: column + region.minX, y: Int(region.columnLast[column])))
        }
        guard let corners = Self.fittedSides(outline, Self.fourSides(hull)) else { return nil }
        let hullArea = Self.area(hull), quadArea = Self.area(corners)
        guard quadArea > 0 else { return nil }
        let fill = min(quadArea, hullArea) / max(quadArea, hullArea)
        guard fill >= 0.82 else { return nil }
        let sides = (0..<4).map { Self.distance(corners[$0], corners[($0 + 1) % 4]) }
        let shortest = sides.min()!, longest = sides.max()!
        guard shortest >= Double(min(width, height)) * minimumSize, shortest / longest >= minimumAspect else { return nil }
        let horizontal = (sides[0] + sides[2]) / 2, vertical = (sides[1] + sides[3]) / 2
        guard min(horizontal, vertical) / max(horizontal, vertical) >= minimumAspect else { return nil }
        let worst = (0..<4).map { abs(Self.angle(corners[($0 + 3) % 4], corners[$0], corners[($0 + 1) % 4]) - 90) }.max()!
        guard worst <= quadratureTolerance,
              corners.allSatisfy({ $0.x >= -2 && $0.y >= -2 && $0.x <= CGFloat(width + 1) && $0.y <= CGFloat(height + 1) })
        else { return nil }
        return (Self.topLeftFirst(corners), fill * (1 - worst / 180) * quadArea)
    }

    // MARK: Plane geometry

    static func distance(_ a: CGPoint, _ b: CGPoint) -> Double { Double(hypot(a.x - b.x, a.y - b.y)) }

    private static func same(_ a: [CGPoint], _ b: [CGPoint]) -> Bool {
        let tolerance = min(distance(a[0], a[1]), distance(a[1], a[2])) * 0.04
        return (0..<4).allSatisfy { distance(a[$0], b[$0]) <= tolerance }
    }

    private static func cross(_ o: CGPoint, _ a: CGPoint, _ b: CGPoint) -> Double {
        Double((a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x))
    }

    private static func area(_ polygon: [CGPoint]) -> Double {
        var total = 0.0
        for index in polygon.indices {
            let a = polygon[index], b = polygon[(index + 1) % polygon.count]
            total += Double(a.x * b.y - b.x * a.y)
        }
        return abs(total) / 2
    }

    private static func angle(_ a: CGPoint, _ b: CGPoint, _ c: CGPoint) -> Double {
        let dot = Double((a.x - b.x) * (c.x - b.x) + (a.y - b.y) * (c.y - b.y))
        return acos(min(1, max(-1, dot / (distance(a, b) * distance(c, b))))) * 180 / .pi
    }

    /// Andrew's chain. The points arrive sorted by row, then column.
    private static func convexHull(_ points: [CGPoint]) -> [CGPoint] {
        var hull: [CGPoint] = []
        func add(_ point: CGPoint, atLeast lower: Int) {
            while hull.count >= lower, cross(hull[hull.count - 2], hull[hull.count - 1], point) <= 0 { hull.removeLast() }
            hull.append(point)
        }
        for point in points { add(point, atLeast: 2) }
        let lower = hull.count + 1
        for point in points.dropLast().reversed() { add(point, atLeast: lower) }
        hull.removeLast()
        return hull
    }

    /// Four sides of a convex polygon: the vertex that costs the least area goes first, and it is
    /// replaced by where its neighbouring edges would meet, so a cut corner is grown back rather than
    /// chopped off further.
    private static func fourSides(_ hull: [CGPoint]) -> [CGPoint] {
        var polygon = hull
        while polygon.count > 4 {
            let count = polygon.count
            var best: (index: Int, cost: Double, point: CGPoint)?
            for index in 0..<count {
                let a = polygon[index], b = polygon[(index + 1) % count]
                guard let meet = intersection(polygon[(index + count - 1) % count], a, b, polygon[(index + 2) % count]) else { continue }
                let cost = abs(cross(a, meet, b))
                if cost < best?.cost ?? .infinity { best = (index, cost, meet) }
            }
            guard let best else { return Array(polygon.prefix(4)) }
            polygon[best.index] = best.point
            polygon.remove(at: (best.index + 1) % count)
        }
        return polygon
    }

    private static func intersection(_ a: CGPoint, _ b: CGPoint, _ c: CGPoint, _ d: CGPoint) -> CGPoint? {
        let ux = b.x - a.x, uy = b.y - a.y, vx = d.x - c.x, vy = d.y - c.y
        let denominator = ux * vy - uy * vx
        guard abs(denominator) >= 1e-6 else { return nil }
        let t = ((c.x - a.x) * vy - (c.y - a.y) * vx) / denominator
        return CGPoint(x: a.x + ux * t, y: a.y + uy * t)
    }

    /// Each side refitted through the outline points beside its middle; the corners are where they meet.
    private static func fittedSides(_ outline: [CGPoint], _ quad: [CGPoint]) -> [CGPoint]? {
        guard quad.count == 4 else { return nil }
        let lines = (0..<4).map { index -> (CGPoint, CGPoint) in
            var line = (quad[index], quad[(index + 1) % 4])
            for tolerance in [3.0, 1.5] {
                guard let fit = fitLine(outline, line.0, line.1, tolerance) else { break }
                line = fit
            }
            return line
        }
        let corners = (0..<4).compactMap { index -> CGPoint? in
            let before = lines[(index + 3) % 4], after = lines[index]
            return intersection(before.0, before.1, after.0, after.1)
        }
        return corners.count == 4 ? corners : nil
    }

    private static func fitLine(_ outline: [CGPoint], _ a: CGPoint, _ b: CGPoint, _ tolerance: Double) -> (CGPoint, CGPoint)? {
        let length = distance(a, b)
        guard length >= 3 else { return nil }
        let ux = Double(b.x - a.x) / length, uy = Double(b.y - a.y) / length
        var count = 0.0, sumX = 0.0, sumY = 0.0, xx = 0.0, xy = 0.0, yy = 0.0
        for point in outline {
            let x = Double(point.x), y = Double(point.y), dx = x - Double(a.x), dy = y - Double(a.y)
            let along = dx * ux + dy * uy
            if along < 0.12 * length || along > 0.88 * length || abs(dy * ux - dx * uy) > tolerance { continue }
            count += 1; sumX += x; sumY += y; xx += x * x; xy += x * y; yy += y * y
        }
        guard count >= 4 else { return nil }
        let meanX = sumX / count, meanY = sumY / count
        // The principal axis of the scatter: total least squares, so a near-vertical side is not special.
        let theta = 0.5 * atan2(2 * (xy / count - meanX * meanY), xx / count - meanX * meanX - (yy / count - meanY * meanY))
        let dirX = cos(theta), dirY = sin(theta), signed = dirX * ux + dirY * uy >= 0 ? length : -length
        return (CGPoint(x: meanX, y: meanY), CGPoint(x: meanX + dirX * signed, y: meanY + dirY * signed))
    }

    private static func topLeftFirst(_ corners: [CGPoint]) -> [CGPoint] {
        let centreX = corners.reduce(0) { $0 + $1.x } / 4, centreY = corners.reduce(0) { $0 + $1.y } / 4
        let clockwise = corners.sorted { atan2($0.y - centreY, $0.x - centreX) < atan2($1.y - centreY, $1.x - centreX) }
        let start = (0..<4).min { clockwise[$0].x + clockwise[$0].y < clockwise[$1].x + clockwise[$1].y }!
        return (0..<4).map { clockwise[(start + $0) % 4] }
    }
}
