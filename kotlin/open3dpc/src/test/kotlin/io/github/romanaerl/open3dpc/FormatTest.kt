package io.github.romanaerl.open3dpc

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

internal val specification = File(System.getProperty("open3dpc.spec"))

class FormatTest {
    private val json = Json.parseToJsonElement(File(specification, "vectors/v2.json").readText()).jsonObject
    private class Vector(val id: String, val h: Int, val w: Int, val payload: String, val rows: List<String>, val region: String, val crc: String)
    private val vectors = json.getValue("vectors").jsonArray.map { it.jsonObject }.map { v ->
        fun text(key: String) = v.getValue(key).jsonPrimitive.content
        Vector(text("id"), v.getValue("h").jsonPrimitive.int, v.getValue("w").jsonPrimitive.int, text("payload"),
            v.getValue("matrixRows").jsonArray.map { it.jsonPrimitive.content }, text("dataRegion"), text("expectedCrc"))
    }

    @Test fun everyVectorEncodesAndValidatesInEveryRotation() {
        assertEquals(30, vectors.size)
        for (v in vectors) {
            assertEquals(v.id, v.rows, Open3DPC.encode(v.payload, v.h, v.w))
            assertEquals(v.id, v.crc, Open3DPC.crc(v.region, v.h))
            var rows = v.rows
            repeat(4) { assertEquals(v.id, v.payload, Open3DPC.validate(rows)); rows = Open3DPC.rotate(rows) }
        }
    }

    @Test fun bothValidatorsAgree() {
        for (v in vectors) {
            val verdict = validatePhysical(v.rows) as PhysicalVerdict.Valid
            assertEquals(v.id, listOf(v.payload, v.h, v.w, v.crc), listOf(verdict.payload, verdict.height, verdict.width, verdict.crc))
        }
    }

    @Test fun anySingleFlippedCellIsRejected() {
        for (v in vectors) for (r in 0 until v.h) for (c in 0 until v.w) {
            if (r == 0 && c == 0) continue
            val rows = v.rows.toMutableList()
            rows[r] = rows[r].replaceRange(c, c + 1, if (rows[r][c] == '1') "0" else "1")
            assertNull("${v.id} [$r,$c]", Open3DPC.validate(rows))
        }
    }

    @Test fun anEmptyDataRegionIsNotACode() {
        val cases = json.getValue("additionalCrcCases").jsonArray
        assertEquals(10, cases.size)
        for (item in cases.map { it.jsonObject }) {
            val h = item.getValue("h").jsonPrimitive.int
            assertEquals(item.getValue("expectedCrc").jsonPrimitive.content, Open3DPC.crc(item.getValue("dataRegion").jsonPrimitive.content, h))
            val w = (1..40).first { Open3DPC.valid(h, it) }
            val blank = List(h) { r -> (if (r == 0) "O" else "0") + "0".repeat(w - 1) }
            assertNull(Open3DPC.validate(blank))
            assertEquals(PhysicalVerdict.EmptyDataRegion, validatePhysical(blank))
        }
    }

    @Test fun badInputIsRefused() {
        assertThrows(IllegalArgumentException::class.java) { Open3DPC.encode("1".repeat(11), 3, 5) }
        assertThrows(IllegalArgumentException::class.java) { Open3DPC.encode("1", 5, 3) }
        assertThrows(IllegalArgumentException::class.java) { Open3DPC.encode("2", 3, 5) }
        assertNull(Open3DPC.validate(emptyList()))
        assertNull(Open3DPC.validate(listOf("O1", "1")))
        assertNull(Open3DPC.validate(listOf("001", "010")))
        assertTrue(Open3DPCGeometry(3, 5).isValid)
        assertFalse(Open3DPCGeometry(5, 3).isValid)
        assertEquals(18, Open3DPCGeometry(4, 6).payloadCapacity)
        assertThrows(IllegalArgumentException::class.java) { Open3DPCFrame(ByteArray(10), 4, 4) }
    }

    private fun reading(bits: String, track: Long = 1) = Open3DPCReading(bits, 3, 5, emptyList(), track)

    @Test fun readingValue() {
        assertEquals(9999L, reading("10011100001111").value)
        assertNull(reading("").value)
        assertNull(reading("1".repeat(64)).value)
        assertNotNull(reading("1".repeat(63)).value)
    }

    @Test fun theStabilizerNeedsTwoFramesOfOneCode() {
        val s = Open3DPCStabilizer()
        assertNull(s.observe(emptyList(), 0))
        assertNull(s.observe(listOf(reading("101")), 1000))
        assertNull(s.observe(listOf(reading("101")), 1000))
        assertEquals("101", s.observe(listOf(reading("101")), 1100)?.bits)
        assertEquals("101", s.observe(emptyList(), 1300)?.bits)
        assertNull(s.observe(emptyList(), 1600))
        assertNull(s.observe(listOf(reading("101")), 2000))
        assertNull(s.observe(listOf(reading("101", 2)), 2100))
        assertNull(s.observe(listOf(reading("111", 2)), 2200))
        assertNull(s.observe(listOf(reading("111", 2), reading("101")), 2250))
        assertNull(s.observe(listOf(reading("111", 2)), 2300))
        assertNull(s.observe(listOf(reading("111", 2)), 2900))
    }

    @Test fun theTorchPolicyLightsOnce() {
        fun run(brightness: Double, seen: Long? = null, on: Boolean = false): Int {
            val policy = LowLightTorchPolicy()
            return (0 until 40).count { policy.shouldLight(brightness, 1000L + it * 100, seen, on) }
        }
        assertEquals(1, run(-3.0)); assertEquals(0, run(3.0)); assertEquals(0, run(Double.NaN))
        assertEquals(0, run(-3.0, on = true)); assertEquals(0, run(-3.0, seen = 4000))
        assertEquals(-5.0, LowLightTorchPolicy.brightness(1.0, 1.0, 100.0)!!, 0.0)
        assertNull(LowLightTorchPolicy.brightness(1.0, 0.0, 100.0))
    }
}
