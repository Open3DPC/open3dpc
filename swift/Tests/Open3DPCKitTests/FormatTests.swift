import XCTest
@testable import Open3DPCKit

final class FormatTests: XCTestCase {
    private func vectors() throws -> [[String: Any]] {
        let list = try XCTUnwrap(Repository.vectors()["vectors"] as? [[String: Any]])
        XCTAssertEqual(list.count, 30)
        return list
    }
    private func matrix(_ v: [String: Any]) throws -> Open3DPC.Matrix {
        try XCTUnwrap(Open3DPC.Matrix(textRows: XCTUnwrap(v["matrixRows"] as? [String])))
    }

    func testEveryVectorEncodesAndValidates() throws {
        for v in try vectors() {
            let id = v["id"] as! String
            let geometry = Open3DPC.Geometry(height: v["h"] as! Int, width: v["w"] as! Int)
            let payload = v["payload"] as! String
            let encoded = try XCTUnwrap(Open3DPC.encode(payload: bits(payload), geometry: geometry), id)
            XCTAssertEqual(encoded.textRows, v["matrixRows"] as? [String], id)
            let code = try Open3DPC.validate(matrix(v)).get()
            XCTAssertEqual(code.payloadBitString, payload, id)
            XCTAssertEqual(code.payloadLength, v["payloadLength"] as? Int, id)
            XCTAssertEqual(code.crcBitString, v["expectedCrc"] as? String, id)
            XCTAssertEqual(code.geometry, geometry, id)
        }
    }

    func testEveryVectorReadsInEveryRotation() throws {
        for v in try vectors() {
            let upright = try Open3DPC.validate(matrix(v)).get()
            var turned = try matrix(v)
            for _ in 0..<3 {
                turned = turned.rotatedClockwise()
                XCTAssertEqual(try Open3DPC.validate(turned).get(), upright, v["id"] as! String)
            }
        }
    }

    func testAnySingleFlippedCellIsRejected() throws {
        for v in try vectors() {
            let rows = try matrix(v).rows
            for r in rows.indices {
                for c in rows[r].indices where !(r == 0 && c == 0) {
                    var flipped = rows
                    flipped[r][c] = flipped[r][c] == .one ? .zero : .one
                    XCTAssertThrowsError(try Open3DPC.validate(.init(rows: flipped)).get(), "\(v["id"]!) [\(r),\(c)]")
                }
            }
        }
    }

    func testPolynomialsAreTheVectors() throws {
        let table = try XCTUnwrap(Repository.vectors()["fullPolynomials"] as? [String: String])
        XCTAssertEqual(table.count, 10)
        for (width, hex) in table { XCTAssertEqual(Open3DPC.Geometry.fullPolynomials[Int(width)!], Int(hex.dropFirst(2), radix: 16)) }
    }

    func testAnEmptyDataRegionIsNotACode() throws {
        let cases = try XCTUnwrap(Repository.vectors()["additionalCrcCases"] as? [[String: Any]])
        XCTAssertEqual(cases.count, 10)
        for item in cases {
            let h = item["h"] as! Int
            XCTAssertEqual(Open3DPC.crc(bits(item["dataRegion"] as! String), width: min(h, 10)), bits(item["expectedCrc"] as! String))
            let w = (1...40).first { Open3DPC.Geometry(height: h, width: $0).isValid }!
            let blank = Open3DPC.Matrix(rows: (0..<h).map { r in (0..<w).map { c in r == 0 && c == 0 ? .orientation : .zero } })
            XCTAssertEqual(Open3DPC.validate(blank), .failure(.emptyDataRegion))
        }
    }

    func testBadInputIsRefused() {
        XCTAssertNil(Open3DPC.encode(payload: Array(repeating: true, count: 11), geometry: .init(height: 3, width: 5)))
        XCTAssertNil(Open3DPC.encode(payload: [true], geometry: .init(height: 5, width: 3)))
        XCTAssertNil(Open3DPC.Matrix(textRows: []))
        XCTAssertNil(Open3DPC.Matrix(textRows: ["O1", "1"]))
        XCTAssertNil(Open3DPC.Matrix(textRows: ["O2"]))
        XCTAssertEqual(Open3DPC.validate(.init(textRows: ["001", "010"])!), .failure(.invalidOrientation))
    }

    func testReadingValue() {
        func reading(_ b: String) -> Open3DPCReading { .init(payload: bits(b), geometry: .init(height: 4, width: 6), corners: [], trackID: 1) }
        XCTAssertEqual(reading("10011100001111").value, 9999)
        XCTAssertEqual(reading("10011100001111").bits, "10011100001111")
        XCTAssertNil(reading("").value)
        XCTAssertNil(reading(String(repeating: "1", count: 65)).value)
    }

    func testStabilizerNeedsTwoFramesOfOneCode() {
        func reading(_ b: String, track: UInt64 = 1) -> Open3DPCReading { .init(payload: bits(b), geometry: .init(height: 3, width: 5), corners: [], trackID: track) }
        let start = Date(timeIntervalSince1970: 1000)
        var s = Open3DPCStabilizer()
        XCTAssertNil(s.observe([reading("101")], at: start))
        XCTAssertNil(s.observe([reading("101")], at: start), "one moment is one look")
        XCTAssertEqual(s.observe([reading("101")], at: start + 0.1)?.bits, "101")
        XCTAssertEqual(s.observe([], at: start + 0.3)?.bits, "101")
        XCTAssertNil(s.observe([], at: start + 0.6))
        XCTAssertNil(s.observe([reading("101")], at: start + 1))
        XCTAssertNil(s.observe([reading("101", track: 2)], at: start + 1.1))
        XCTAssertNil(s.observe([reading("111", track: 2)], at: start + 1.2))
        XCTAssertNil(s.observe([reading("111", track: 2), reading("101")], at: start + 1.25))
        XCTAssertNil(s.observe([reading("111", track: 2)], at: start + 1.3))
        XCTAssertNil(s.observe([reading("111", track: 2)], at: start + 1.9), "too far apart")
    }

    func testTorchPolicy() {
        let start = Date(timeIntervalSince1970: 1000)
        func run(_ brightness: Double, codeSeenAt: Date? = nil, torchIsOn: Bool = false) -> Int {
            var policy = LowLightTorchPolicy()
            return (0..<40).filter { policy.shouldLight(brightness: brightness, at: start + Double($0) * 0.1, codeSeenAt: codeSeenAt, torchIsOn: torchIsOn) }.count
        }
        XCTAssertEqual(run(-3), 1)
        XCTAssertEqual(run(3), 0)
        XCTAssertEqual(run(.nan), 0)
        XCTAssertEqual(run(-3, torchIsOn: true), 0)
        XCTAssertEqual(run(-3, codeSeenAt: start + 3), 0)
        XCTAssertEqual(LowLightTorchPolicy.brightness(aperture: 1, exposureSeconds: 1, iso: 100), -5)
        XCTAssertNil(LowLightTorchPolicy.brightness(aperture: 1, exposureSeconds: 0, iso: 100))
    }
}
