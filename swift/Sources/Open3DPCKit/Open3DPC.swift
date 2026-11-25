// Copyright 2026 Roman Simonov. Licensed under the Apache License, Version 2.0.

import Foundation

/// Physical Open3D Print Code v2 validation, intentionally independent from camera and UI code.
/// A camera/frame decoder supplies a sampled matrix; this type owns geometry, traversal, rotation,
/// CRC validation and terminator recovery, and hands the application layer exactly two things: the
/// payload bits and their count (spec/v2.md §9).
public enum Open3DPC {
    public struct Geometry: Hashable, Sendable {
        public let height: Int
        public let width: Int

        public init(height: Int, width: Int) {
            self.height = height
            self.width = width
        }

        public var crcWidth: Int { min(height, 10) }
        /// Every non-orientation, non-CRC cell: payload, terminator and padding together (§4).
        public var dataRegionLength: Int { height * width - crcWidth - 1 }
        /// The terminator is always present, so it is never available to the payload (§4).
        public var payloadCapacity: Int { dataRegionLength - 1 }

        public var isValid: Bool {
            height > 0 && width > 0 && payloadCapacity >= 2 * crcWidth
        }

        /// CRC width derives from height, so validity is orientation-dependent by construction:
        /// `3 × 5` is valid where `5 × 3` is not. A scanner that measures a lattice from the image
        /// has not yet normalized rotation, so it must admit a hypothesis whose transpose is valid
        /// and let `Matrix.normalized()` plus CRC decide the real geometry. This widens what may be
        /// *sampled*; it grants nothing acceptance authority.
        public var isValidInSomeOrientation: Bool {
            isValid || Geometry(height: width, width: height).isValid
        }

        public var fullPolynomial: Int? {
            guard isValid else { return nil }
            return Self.fullPolynomials[crcWidth]
        }

        public static let fullPolynomials: [Int: Int] = [
            1: 0x3, 2: 0x7, 3: 0xB, 4: 0x13, 5: 0x25,
            6: 0x67, 7: 0xCB, 8: 0x107, 9: 0x2FB, 10: 0x48F,
        ]
    }

    public enum Cell: Character, Equatable, Sendable {
        case zero = "0"
        case one = "1"
        case orientation = "O"
    }

    /// A fully sampled logical matrix. `O` is structural and must occur exactly once.
    public struct Matrix: Equatable, Sendable {
        public let rows: [[Cell]]

        public var height: Int { rows.count }
        public var width: Int { rows.first?.count ?? 0 }
        public var geometry: Geometry { Geometry(height: height, width: width) }

        init(rows: [[Cell]]) {
            self.rows = rows
        }

        public init?(textRows: [String]) {
            guard !textRows.isEmpty else { return nil }
            let rows = textRows.map { $0.compactMap(Cell.init(rawValue:)) }
            guard rows.allSatisfy({ $0.count == textRows.first?.count }),
                  rows.flatMap({ $0 }).count == textRows.reduce(0, { $0 + $1.count }) else {
                return nil
            }
            self.rows = rows
        }

        /// The `O`/`1`/`0` rows of §7, the form the conformance vectors carry.
        public var textRows: [String] {
            rows.map { String($0.map(\.rawValue)) }
        }

        public func rotatedClockwise() -> Matrix {
            guard height > 0, width > 0 else { return self }
            return Matrix(rows: (0..<width).map { column in
                (0..<height).reversed().map { row in rows[row][column] }
            })
        }

        /// Rotate only in 90-degree increments until the unique orientation feature is `[0,0]`.
        ///
        /// A single-row code is the one shape where two quarter turns both put the feature at
        /// `[0,0]` — `1 × 5` and its clockwise turn `5 × 1` — and only one of them is a geometry
        /// §4 admits. Of the rotations that satisfy step 3 of the scanner contract, prefer the one
        /// that also passes step 4; when none does, the first is returned and `validate` rejects
        /// it as invalid geometry, exactly as before.
        public func normalized() -> Matrix? {
            var value = self
            var firstAtOrigin: Matrix?
            for _ in 0..<4 {
                let positions = value.rows.enumerated().flatMap { row, cells in
                    cells.enumerated().compactMap { column, cell in
                        cell == .orientation ? (row, column) : nil
                    }
                }
                guard positions.count == 1 else { return nil }
                if positions[0].0 == 0, positions[0].1 == 0 {
                    if value.geometry.isValid { return value }
                    firstAtOrigin = firstAtOrigin ?? value
                }
                value = value.rotatedClockwise()
            }
            return firstAtOrigin
        }
    }

    /// What the physical layer hands on: the payload and its length. The terminator and the
    /// padding it recovered them from stay here (§9 step 10); CRC bits are kept as diagnostics.
    public struct Validated: Equatable, Sendable {
        public let geometry: Geometry
        public let payload: [Bool]
        public let crcBits: [Bool]

        public var payloadLength: Int { payload.count }
        public var payloadBitString: String { Self.string(from: payload) }
        public var crcBitString: String { Self.string(from: crcBits) }

        private static func string(from bits: [Bool]) -> String {
            String(bits.map { $0 ? "1" : "0" })
        }
    }

    public enum ValidationError: Error, Equatable {
        case invalidGeometry
        case invalidOrientation
        case malformedMatrix
        case crcMismatch
        /// The CRC matched but no cell is set: an all-zero region has an all-zero CRC, and the
        /// terminator exists so that a blank matrix is not a code (§5.3).
        case emptyDataRegion
    }

    public static func validate(_ observed: Matrix) -> Result<Validated, ValidationError> {
        guard let matrix = observed.normalized() else { return .failure(.invalidOrientation) }
        let geometry = matrix.geometry
        guard geometry.isValid, let polynomial = geometry.fullPolynomial else {
            return .failure(.invalidGeometry)
        }

        var dataBits: [Bool] = []
        var crcBits: [Bool] = []
        for row in 0..<geometry.height {
            for column in 0..<geometry.width {
                let cell = matrix.rows[row][column]
                if row == 0, column == 0 {
                    guard cell == .orientation else { return .failure(.invalidOrientation) }
                    continue
                }
                if column == geometry.width - 1, row < geometry.crcWidth {
                    guard let bit = bit(from: cell) else { return .failure(.malformedMatrix) }
                    crcBits.append(bit)
                } else {
                    guard let bit = bit(from: cell) else { return .failure(.malformedMatrix) }
                    dataBits.append(bit)
                }
            }
        }

        guard dataBits.count == geometry.dataRegionLength, crcBits.count == geometry.crcWidth else {
            return .failure(.malformedMatrix)
        }
        guard crc(dataBits, width: geometry.crcWidth, fullPolynomial: polynomial) == crcBits else {
            return .failure(.crcMismatch)
        }
        // §5.3: the payload is everything before the last `1`; a region without one is not a code.
        guard let terminator = dataBits.lastIndex(of: true) else {
            return .failure(.emptyDataRegion)
        }
        return .success(Validated(
            geometry: geometry, payload: Array(dataBits[..<terminator]), crcBits: crcBits
        ))
    }

    public static func encode(payload: [Bool], geometry: Geometry) -> Matrix? {
        guard geometry.isValid, let polynomial = geometry.fullPolynomial,
              payload.count <= geometry.payloadCapacity else { return nil }
        var dataBits = payload
        dataBits.append(true)
        dataBits.append(contentsOf: Array(repeating: false, count: geometry.dataRegionLength - dataBits.count))
        let crcBits = crc(dataBits, width: geometry.crcWidth, fullPolynomial: polynomial)
        var data = dataBits.makeIterator()
        var rows: [[Cell]] = []
        for row in 0..<geometry.height {
            var cells: [Cell] = []
            for column in 0..<geometry.width {
                if row == 0, column == 0 {
                    cells.append(.orientation)
                } else if column == geometry.width - 1, row < geometry.crcWidth {
                    cells.append(crcBits[row] ? .one : .zero)
                } else {
                    cells.append(data.next()! ? .one : .zero)
                }
            }
            rows.append(cells)
        }
        return Matrix(rows: rows)
    }

    /// Canonical non-reflected modulo-2 CRC over a bit stream, MSB first.
    public static func crc(_ bits: [Bool], width: Int, fullPolynomial: Int? = nil) -> [Bool] {
        guard let polynomial = fullPolynomial ?? Geometry.fullPolynomials[min(width, 10)], width > 0 else {
            return []
        }
        let mask = (1 << width) - 1
        let lowerPolynomial = polynomial & mask
        var remainder = 0
        for bit in bits {
            let top = ((remainder >> (width - 1)) & 1) ^ (bit ? 1 : 0)
            remainder = (remainder << 1) & mask
            if top == 1 { remainder ^= lowerPolynomial }
        }
        return (0..<width).reversed().map { ((remainder >> $0) & 1) == 1 }
    }

    private static func bit(from cell: Cell) -> Bool? {
        switch cell {
        case .zero: return false
        case .one: return true
        case .orientation: return nil
        }
    }
}
