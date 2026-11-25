import CoreGraphics
import Foundation
import XCTest
@testable import Open3DPCKit

enum Repository {
    static let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    static func json(_ path: String) throws -> Any {
        try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent(path)))
    }
    static func vectors() throws -> [String: Any] { try XCTUnwrap(json("spec/vectors/v2.json") as? [String: Any]) }
}

func bits(_ text: String) -> [Bool] { text.map { $0 == "1" } }

/// A top-down grey image.
struct Grey {
    var width: Int
    var height: Int
    var pixels: [UInt8]

    init(width: Int, height: Int, value: UInt8 = 255) {
        self.width = width
        self.height = height
        pixels = Array(repeating: value, count: width * height)
    }

    /// Binary PGM, as generator/test/fixtures.js writes it.
    init(pgm url: URL) throws {
        let data = try Data(contentsOf: url)
        let ends = Array(data.indices.lazy.filter { data[$0] == 10 }.prefix(3))
        let size = try XCTUnwrap(String(data: data[(ends[0] + 1)..<ends[1]], encoding: .ascii)).split(separator: " ").compactMap { Int($0) }
        width = size[0]
        height = size[1]
        pixels = Array(data[(ends[2] + 1)...])
        XCTAssertEqual(pixels.count, width * height)
    }

    /// The exact construction of spec/v2.md §3, `module` pixels per cell, with `margin` modules around.
    init(_ matrix: Open3DPC.Matrix, module m: Int, margin: Int = 0, dark: UInt8 = 17, light: UInt8 = 255) {
        self.init(width: (matrix.width + 2 + 2 * margin) * m, height: (matrix.height + 2 + 2 * margin) * m, value: light)
        let o = margin * m, f = m / 2, w = (matrix.width + 2) * m, h = (matrix.height + 2) * m
        fill(o, o, w, h, dark)
        fill(o + f, o + f, w - m, h - m, light)
        for (r, row) in matrix.rows.enumerated() {
            for (c, cell) in row.enumerated() {
                if cell == .orientation { fill(o + f, o + f, m, m, dark) }
                if cell == .one { fill(o + (c + 1) * m, o + (r + 1) * m, m, m, dark) }
            }
        }
    }

    mutating func fill(_ x: Int, _ y: Int, _ w: Int, _ h: Int, _ value: UInt8) {
        for row in y..<(y + h) { for column in x..<(x + w) { pixels[row * width + column] = value } }
    }

    func rotated() -> Grey {
        var out = Grey(width: height, height: width)
        for y in 0..<height { for x in 0..<width { out.pixels[x * height + height - 1 - y] = pixels[y * width + x] } }
        return out
    }

    /// Rotated by any angle about the centre, on a canvas of `value`.
    func turned(degrees: Double, value: UInt8 = 255) -> Grey {
        let a = degrees * .pi / 180, side = Int(Double(width * width + height * height).squareRoot()) + 40
        var out = Grey(width: side, height: side, value: value)
        for y in 0..<side {
            for x in 0..<side {
                let dx = Double(x) - Double(side) / 2, dy = Double(y) - Double(side) / 2
                let sx = dx * cos(a) + dy * sin(a) + Double(width) / 2, sy = -dx * sin(a) + dy * cos(a) + Double(height) / 2
                let x0 = Int(sx.rounded(.down)), y0 = Int(sy.rounded(.down))
                guard x0 >= 0, y0 >= 0, x0 + 1 < width, y0 + 1 < height else { continue }
                let fx = sx - Double(x0), fy = sy - Double(y0)
                func p(_ x: Int, _ y: Int) -> Double { Double(pixels[y * width + x]) }
                let v = (p(x0, y0) * (1 - fx) + p(x0 + 1, y0) * fx) * (1 - fy) + (p(x0, y0 + 1) * (1 - fx) + p(x0 + 1, y0 + 1) * fx) * fy
                out.pixels[y * side + x] = UInt8(v.rounded())
            }
        }
        return out
    }

    var rgba: Data {
        var data = Data(capacity: pixels.count * 4)
        for p in pixels { data.append(contentsOf: [p, p, p, 255]) }
        return data
    }

    var image: CGImage {
        CGImage(
            width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: width,
            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGBitmapInfo(rawValue: 0),
            provider: CGDataProvider(data: Data(pixels) as CFData)!, decode: nil, shouldInterpolate: false, intent: .defaultIntent
        )!
    }
}
