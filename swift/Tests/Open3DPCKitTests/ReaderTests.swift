import XCTest
@testable import Open3DPCKit

/// The whole path on images: rectangle proposals, registration, sampling, validation.
final class ReaderTests: XCTestCase {
    private struct Fixture: Decodable { let file: String; let payload: String; let h: Int; let w: Int }

    private func fixtures() throws -> [(Fixture, Grey)] {
        let folder = Repository.root.appendingPathComponent("spec/fixtures")
        let list = try JSONDecoder().decode([Fixture].self, from: Data(contentsOf: folder.appendingPathComponent("manifest.json")))
        XCTAssertEqual(list.count, 10)
        return try list.map { ($0, try Grey(pgm: folder.appendingPathComponent($0.file))) }
    }

    private func assertReads(_ image: Grey, _ payload: String, _ label: String, file: StaticString = #filePath, line: UInt = #line) {
        let readings = Open3DPCReader().read(image.image)
        XCTAssertEqual(readings.map(\.bits), [payload], label, file: file, line: line)
    }

    private let angles = [0.0, 3, 5, 8, 12, 20, 33]

    /// Every picture the generator drew, at seven angles. A single frame may be refused, so a code has
    /// to read at four of the seven; a wrong payload is never allowed.
    func testGeneratedCodesRead() throws {
        for (fixture, image) in try fixtures() {
            var read = 0
            for angle in angles {
                let found = Open3DPCReader().read(angle == 0 ? image.image : image.turned(degrees: angle).image).map(\.bits)
                XCTAssertTrue(found.allSatisfy { $0 == fixture.payload }, "\(fixture.file) \(angle)°: \(found)")
                if found == [fixture.payload] { read += 1 }
            }
            print("read \(fixture.file): \(read) of \(angles.count)")
            XCTAssertGreaterThanOrEqual(read, 4, fixture.file)
        }
    }

    /// Two-row codes are left out: the sampler refuses this one at some quarter turns.
    func testGeneratedCodesReadInEveryRotation() throws {
        for (fixture, image) in try fixtures() where fixture.h > 2 {
            var turned = [3.0, 8, 12].map { image.turned(degrees: $0) }
            for turn in 1...3 {
                turned = turned.map { $0.rotated() }
                let found = turned.map { Open3DPCReader().read($0.image).map(\.bits) }
                XCTAssertTrue(found.joined().allSatisfy { $0 == fixture.payload }, "\(fixture.file) \(turn * 90)°: \(found)")
                XCTAssertTrue(found.contains([fixture.payload]), "\(fixture.file) \(turn * 90)°: \(found)")
            }
        }
    }

    func testLightOnDark() throws {
        let matrix = try XCTUnwrap(Open3DPC.encode(payload: bits("10011100001111"), geometry: .init(height: 4, width: 6)))
        assertReads(Grey(matrix, module: 24, margin: 4, dark: 235, light: 25).turned(degrees: 8, value: 25), "10011100001111", "light on dark")
    }

    func testOptionsRefuseOtherLengthsAndShapes() throws {
        let matrix = try XCTUnwrap(Open3DPC.encode(payload: bits("10011100001111"), geometry: .init(height: 4, width: 6)))
        let image = Grey(matrix, module: 24, margin: 4).turned(degrees: 8).image
        func count(_ options: Open3DPCReader.Options) -> Int { Open3DPCReader(options: options).read(image).count }
        XCTAssertEqual(count(.init()), 1)
        XCTAssertEqual(count(.init(payloadLengths: [14])), 1)
        XCTAssertEqual(count(.init(payloadLengths: [9, 13])), 0)
        XCTAssertEqual(count(.init(geometries: [.init(height: 4, width: 6)])), 1)
        XCTAssertEqual(count(.init(geometries: [.init(height: 6, width: 4)])), 0)
    }

    func testRegionOfInterestBoundsTheSearch() throws {
        let matrix = try XCTUnwrap(Open3DPC.encode(payload: bits("10011100001111"), geometry: .init(height: 4, width: 6)))
        let image = Grey(matrix, module: 24, margin: 6).turned(degrees: 8)
        var buffer: CVPixelBuffer?
        CVPixelBufferCreate(nil, image.width & ~1, image.height & ~1, kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
                            [kCVPixelBufferIOSurfacePropertiesKey: [String: Any]()] as CFDictionary, &buffer)
        let pixels = try XCTUnwrap(buffer)
        CIContext().render(CIImage(cgImage: image.image), to: pixels)
        XCTAssertEqual(Open3DPCReader().read(pixels).map(\.bits), ["10011100001111"])
        XCTAssertEqual(Open3DPCReader().read(pixels, regionOfInterest: CGRect(x: 0, y: 0, width: 0.2, height: 1)).count, 0)
    }

    func testTrackSurvivesFramesAndConfirms() throws {
        let matrix = try XCTUnwrap(Open3DPC.encode(payload: bits("010011011"), geometry: .init(height: 3, width: 5)))
        let image = Grey(matrix, module: 24, margin: 4).image
        let reader = Open3DPCReader()
        var stabilizer = Open3DPCStabilizer()
        let start = Date()
        XCTAssertNil(stabilizer.observe(reader.read(image), at: start))
        XCTAssertEqual(stabilizer.observe(reader.read(image), at: start + 0.1)?.bits, "010011011")
    }

    func testNothingReadsFromABlankImage() {
        XCTAssertEqual(Open3DPCReader().read(Grey(width: 640, height: 360).image).count, 0)
        XCTAssertEqual(Open3DPCReader().read(Grey(width: 8, height: 8).image).count, 0)
    }

    func testABlankMatrixIsNotRead() throws {
        let blank = Open3DPC.Matrix(rows: (0..<4).map { r in (0..<6).map { c in r == 0 && c == 0 ? .orientation : .zero } })
        XCTAssertEqual(Open3DPCReader().read(Grey(blank, module: 24, margin: 4).image).count, 0)
    }

    /// The sampler alone, on exact rasters: every nine-bit value that starts 010 and every module size.
    func testSamplerReadsExactRasters() throws {
        for module in [10, 14, 20, 28, 40] {
            for value in stride(from: 0, to: 64, by: 3) {
                let payload = "010" + String(String(value, radix: 2).reversed()).padding(toLength: 6, withPad: "0", startingAt: 0)
                let matrix = try XCTUnwrap(Open3DPC.encode(payload: bits(payload), geometry: .init(height: 3, width: 5)))
                let raster = Grey(matrix, module: module)
                let outcome = Open3DPCFrameDecoder().analyzeFixture(.init(
                    id: payload, width: raster.width, height: raster.height, rgba: raster.rgba,
                    expectedStage: .validated, expectedGeometry: nil, expectedPayload: nil
                ))
                XCTAssertEqual(outcome.payload, bits(payload), "\(payload) at \(module) px: \(outcome.detail)")
            }
        }
    }

    /// A dark data row or column is as long as a side of the frame and must not be taken for one.
    func testDataRowsAreNotFrameSides() throws {
        for (height, width) in [(4, 6), (6, 4), (3, 7), (5, 5), (4, 5)] {
            for number in Array(stride(from: 1, through: 9999, by: 37 * 5)) + [963] {
                let payload = bits(String(repeating: "0", count: 14 - String(number, radix: 2).count) + String(number, radix: 2))
                let matrix = try XCTUnwrap(Open3DPC.encode(payload: payload, geometry: .init(height: height, width: width)))
                let code = Grey(matrix, module: 24)
                var raster = Grey(width: code.width + 24, height: code.height + 24)
                for y in 0..<code.height { for x in 0..<code.width { raster.pixels[(y + 12) * raster.width + x + 12] = code.pixels[y * code.width + x] } }
                let outcome = Open3DPCFrameDecoder().analyzeFixture(.init(
                    id: "", width: raster.width, height: raster.height, rgba: raster.rgba,
                    expectedStage: .validated, expectedGeometry: nil, expectedPayload: nil
                ))
                XCTAssertEqual(outcome.payload, payload, "\(number) on \(height)×\(width): \(outcome.detail)")
            }
        }
    }

    /// Told the shape, the reader takes the module from the frame itself, so glare cannot make a row of
    /// dark cells one row longer. The same as generator/test/reader.test.js.
    func testAcceptedShapesGiveTheModuleSoGlareCannotChangeTheShape() throws {
        var plain = 0, hinted = 0
        for (text, height, width) in [(String(repeating: "1", count: 14), 2, 11), (String(repeating: "1", count: 14), 3, 7),
                                      (String(repeating: "1", count: 14), 2, 9), ("10011100001111", 4, 5)] {
            let geometry = Open3DPC.Geometry(height: height, width: width)
            let matrix = try XCTUnwrap(Open3DPC.encode(payload: bits(text), geometry: geometry))
            for module in [6, 10] {
                for (radius, lift) in [(1, 40), (1, 110), (3, 40), (3, 110)] {
                    let picture = Grey(matrix, module: module, margin: 1).glared(radius: radius, lift: lift).image
                    let found = Open3DPCReader(options: .init(geometries: [geometry])).read(picture)
                    XCTAssertTrue(found.allSatisfy { $0.payload == bits(text) && $0.geometry == geometry }, "\(geometry) at \(module), glare \(radius)/\(lift): \(found)")
                    if !found.isEmpty { hinted += 1 }
                    if Open3DPCReader().read(picture).contains(where: { $0.payload == bits(text) && $0.geometry == geometry }) { plain += 1 }
                }
            }
        }
        print("glare: \(hinted) of 32 read with the shape, \(plain) without")
        XCTAssertGreaterThanOrEqual(hinted, plain)
    }

    /// A shape one row or column off is the likeliest wrong guess: told only that one, the reader reads nothing.
    func testAShapeTheCodeDoesNotHaveIsNeverForcedOnIt() throws {
        for (text, height, width) in [("10011100001111", 4, 5), (String(repeating: "1", count: 14), 2, 9), (String(repeating: "1", count: 14), 3, 7)] {
            let matrix = try XCTUnwrap(Open3DPC.encode(payload: bits(text), geometry: .init(height: height, width: width)))
            for (dh, dw) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                for (radius, lift) in [(0, 0), (2, 80)] {
                    let picture = Grey(matrix, module: 8, margin: 1).glared(radius: radius, lift: lift).turned(degrees: 20).image
                    let told = Open3DPC.Geometry(height: height + dh, width: width + dw)
                    XCTAssertEqual(Open3DPCReader(options: .init(geometries: [told])).read(picture).count, 0, "\(height)×\(width) told \(told), glare \(radius)")
                }
            }
        }
    }

    /// Small codes: the proposal has to lie on the frame, or the corner step is looked for in the margin.
    func testSmallCodesReadAtEveryAngle() throws {
        for (height, width, length) in [(4, 6, 14), (3, 5, 9), (10, 10, 60)] {
            for module in [18, 34] {
                var read = 0
                for step in 0..<6 {
                    let payload = (0..<length).map { ($0 * $0 * 5 + step * $0 * 3 + step) % 7 < 3 }
                    let matrix = try XCTUnwrap(Open3DPC.encode(payload: payload, geometry: .init(height: height, width: width)))
                    let picture = Grey(matrix, module: module, margin: 4).turned(degrees: Double(step) * 60 + 7)
                    let found = Open3DPCReader().read(picture.image)
                    XCTAssertTrue(found.allSatisfy { $0.payload == payload }, "\(height)×\(width) at \(module): \(found)")
                    if found.count == 1 { read += 1 }
                }
                XCTAssertGreaterThanOrEqual(read, 5, "\(height)×\(width), \(module) px a module")
            }
        }
    }
}
