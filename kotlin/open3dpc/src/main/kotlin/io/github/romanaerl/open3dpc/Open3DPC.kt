// Copyright 2026 Roman Simonov. Licensed under the Apache License, Version 2.0.

package io.github.romanaerl.open3dpc

/** The physical layer of spec/v2.md §§4–6 and 9 on text matrices: rows of `0`, `1` and one `O`, the orientation feature. */
object Open3DPC {
    private val polynomials = intArrayOf(0, 0x3, 0x7, 0xB, 0x13, 0x25, 0x67, 0xCB, 0x107, 0x2FB, 0x48F)
    /** Payload bits an `h` × `w` (rows × columns) matrix holds. */
    fun capacity(h: Int, w: Int) = h * w - minOf(h, 10) - 2
    /** Whether the geometry is a valid v2 one, §4. */
    fun valid(h: Int, w: Int) = h > 0 && w > 0 && capacity(h, w) >= 2 * minOf(h, 10)
    fun crc(bits: String, height: Int): String {
        require(height > 0 && bits.all { it == '0' || it == '1' })
        val width = minOf(height, 10)
        var remainder = 0
        for (bit in bits + "0".repeat(width)) {
            remainder = (remainder shl 1) or (bit - '0')
            if ((remainder and (1 shl width)) != 0) remainder = remainder xor polynomials[width]
        }
        return remainder.toString(2).padStart(width, '0')
    }
    /** The matrix of a payload, §5; throws when the geometry is invalid or the payload does not fit. */
    fun encode(payload: String, h: Int, w: Int): List<String> {
        require(valid(h, w) && payload.length <= capacity(h, w) && payload.all { it in '0'..'1' })
        val data = payload + "1" + "0".repeat(capacity(h, w) - payload.length)
        val check = crc(data, h)
        var offset = 0
        return List(h) { r -> buildString { repeat(w) { c -> append(when {
            r == 0 && c == 0 -> 'O'
            c == w - 1 && r < minOf(h, 10) -> check[r]
            else -> data[offset++]
        }) } } }
    }
    /** A quarter turn clockwise. */
    fun rotate(rows: List<String>): List<String> = List(rows[0].length) { c -> rows.indices.reversed().map { r -> rows[r][c] }.joinToString("") }
    /** The payload of a sampled matrix in any of four rotations, or null when it is not a code. */
    fun validate(matrix: List<String>): String? {
        if (matrix.isEmpty() || matrix[0].isEmpty() || matrix.any { it.length != matrix[0].length || it.any { c -> c !in "01O" } } || matrix.sumOf { row -> row.count { it == 'O' } } != 1) return null
        var rows = matrix
        repeat(4) {
            if (rows[0][0] == 'O' && valid(rows.size, rows[0].length)) {
                val h = rows.size; val w = rows[0].length
                val width = minOf(h, 10)
                val data = buildString { for (r in 0 until h) for (c in 0 until w) if (!(r == 0 && c == 0) && !(c == w - 1 && r < width)) append(rows[r][c]) }
                val check = (0 until width).map { rows[it][w - 1] }.joinToString("")
                if (crc(data, h) != check) return null
                val last = data.lastIndexOf('1')
                return if (last < 0) null else data.take(last)
            }
            rows = rotate(rows)
        }
        return null
    }
}
