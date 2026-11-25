package io.github.romanaerl.open3dpc

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.ByteBuffer
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.sin

/** The whole path on images: proposals, registration, sampling, validation. */
class ReaderTest {
    private class Grey(val width: Int, val height: Int, val pixels: ByteArray) {
        fun frame() = Open3DPCFrame(pixels, width, height)

        /** Rotated about the centre on a white canvas. */
        fun turned(degrees: Double): Grey {
            if (degrees == 0.0) return this
            val a = Math.toRadians(degrees)
            val side = hypot(width.toDouble(), height.toDouble()).toInt() + 40
            val out = ByteArray(side * side) { -1 }
            for (y in 0 until side) for (x in 0 until side) {
                val dx = x - side / 2.0
                val dy = y - side / 2.0
                val sx = dx * cos(a) + dy * sin(a) + width / 2.0
                val sy = -dx * sin(a) + dy * cos(a) + height / 2.0
                val x0 = floor(sx).toInt()
                val y0 = floor(sy).toInt()
                if (x0 < 0 || y0 < 0 || x0 + 1 >= width || y0 + 1 >= height) continue
                val fx = sx - x0
                val fy = sy - y0
                fun p(px: Int, py: Int) = (pixels[py * width + px].toInt() and 255).toDouble()
                out[y * side + x] = swiftRound((p(x0, y0) * (1 - fx) + p(x0 + 1, y0) * fx) * (1 - fy) + (p(x0, y0 + 1) * (1 - fx) + p(x0 + 1, y0 + 1) * fx) * fy).toInt().toByte()
            }
            return Grey(side, side, out)
        }
        fun quarter() = Grey(height, width, ByteArray(pixels.size).also { for (y in 0 until height) for (x in 0 until width) it[x * height + height - 1 - y] = pixels[y * width + x] })
    }
    private class Fixture(val file: String, val payload: String, val rows: Int, val columns: Int, val image: Grey)

    private val fixtures = Json.parseToJsonElement(File(specification, "fixtures/manifest.json").readText()).jsonArray.map { it.jsonObject }.map { f ->
        val name = f.getValue("file").jsonPrimitive.content
        val data = File(specification, "fixtures/$name").readBytes()
        val ends = data.indices.filter { data[it] == 10.toByte() }.take(3)
        val (w, h) = String(data, ends[0] + 1, ends[1] - ends[0] - 1).split(" ").map(String::toInt)
        Fixture(name, f.getValue("payload").jsonPrimitive.content, f.getValue("h").jsonPrimitive.int, f.getValue("w").jsonPrimitive.int, Grey(w, h, data.copyOfRange(ends[2] + 1, data.size)))
    }
    private fun fixture(name: String) = fixtures.first { it.file == "$name.pgm" }

    /** Every picture the generator drew, at seven angles and four turns; a wrong payload is never allowed. */
    @Test fun generatedCodesRead() {
        assertEquals(10, fixtures.size)
        for (f in fixtures) {
            var image = f.image
            for (turn in 0 until 4) {
                var read = 0
                for (angle in listOf(0.0, 3.0, 5.0, 8.0, 12.0, 20.0, 33.0)) {
                    val found = Open3DPCReader().read(image.turned(angle).frame())
                    assertTrue("${f.file} $angle $found", found.all { it.bits == f.payload && it.rows == f.rows && it.columns == f.columns })
                    if (found.size == 1) read++
                }
                println("read ${f.file} turn ${turn * 90}: $read of 7")
                if (f.rows > 2) assertTrue("${f.file} turn ${turn * 90}: $read of 7", read >= 4)
                image = image.quarter()
            }
        }
    }

    private fun nv12(raster: ReferenceRaster): Open3DPCFrame {
        val width = raster.width and 1.inv()
        val height = raster.height and 1.inv()
        val luma = ByteArray(width * height)
        val chroma = ByteArray(width * (height / 2)) { -128 }
        for (y in 0 until height) for (x in 0 until width) luma[y * width + x] = raster.rgba[(y * raster.width + x) * 4]
        return Open3DPCFrame(luma, width, height, width, chroma)
    }

    private fun read(pose: PlanePose, pair: MaterialPair): Int = testCodes().count { code ->
        val (frame, _) = ReferenceRaster.render(code.matrix, 20, pair = pair).projected(pose, margin = 1.2, canvas = pair.background[0].toByte())
        Open3DPCReader().read(nv12(frame)).map { it.bits } == listOf(code.payload)
    }

    @Test fun fortyCodesReadInPerspective() {
        assertEquals(40, read(PlanePose(), MaterialPair.DarkOnLight))
        assertEquals(40, read(PlanePose(20.0, roll = 12.0), MaterialPair.DarkOnLight))
        assertEquals(40, read(PlanePose(pitch = 30.0), MaterialPair.DarkOnLight))
        assertEquals(40, read(PlanePose(10.0), MaterialPair.LightOnDark))
    }

    @Test fun optionsRefuseOtherLengthsAndShapes() {
        val image = fixture("number-9999-6x4").image.turned(8.0).frame()
        fun count(reader: Open3DPCReader) = reader.read(image).size
        assertEquals(1, count(Open3DPCReader()))
        assertEquals(1, count(Open3DPCReader(payloadLengths = setOf(14))))
        assertEquals(0, count(Open3DPCReader(payloadLengths = setOf(9, 13))))
        assertEquals(1, count(Open3DPCReader(geometries = setOf(Open3DPCGeometry(6, 4)))))
        assertEquals(0, count(Open3DPCReader(geometries = setOf(Open3DPCGeometry(4, 6)))))
    }

    @Test fun theRegionOfInterestBoundsTheSearch() {
        val frame = fixture("bits9-3x5").image.frame()
        assertEquals(1, Open3DPCReader().read(frame).size)
        assertEquals(0, Open3DPCReader().read(frame, FrameRect(0f, 0f, 60f, frame.height.toFloat())).size)
    }

    @Test fun aTrackSurvivesFramesAndConfirms() {
        val frame = fixture("bits9-3x5").image.frame()
        val reader = Open3DPCReader()
        val stabilizer = Open3DPCStabilizer()
        assertEquals(null, stabilizer.observe(reader.read(frame), 1000))
        assertEquals("010011011", stabilizer.observe(reader.read(frame), 1100)?.bits)
    }

    @Test fun nothingReadsFromABlankImageOrABlankMatrix() {
        assertEquals(0, Open3DPCReader().read(Open3DPCFrame(ByteArray(640 * 360) { -1 }, 640, 360)).size)
        assertEquals(0, Open3DPCReader().read(Open3DPCFrame(ByteArray(64), 8, 8)).size)
        val blank = listOf("O00000", "000000", "000000", "000000")
        val (frame, _) = ReferenceRaster.render(blank, 20).projected(PlanePose(), margin = 1.2)
        assertEquals(0, Open3DPCReader().read(nv12(frame)).size)
    }

    @Test fun planesCopyWithTheirStrides() {
        val y = ByteBuffer.wrap(ByteArray(24) { it.toByte() })
        val semiPlanar = ByteBuffer.wrap(byteArrayOf(10, 20, 11, 21, 0, 0, 12, 22, 13, 23, 0))
        val v = semiPlanar.duplicate().also { it.position(1) }.slice()
        val frame = Open3DPCFrame.fromYuv420(4, 4, y, 6, semiPlanar, v, 6, 2)
        assertArrayEquals(byteArrayOf(0, 1, 2, 3, 6, 7, 8, 9, 12, 13, 14, 15, 18, 19, 20, 21), frame.luma)
        assertArrayEquals(byteArrayOf(10, 20, 11, 21, 12, 22, 13, 23), frame.chroma)
        val planar = Open3DPCFrame.fromYuv420(4, 4, y, 6, ByteBuffer.wrap(byteArrayOf(1, 2, 3, 4)), ByteBuffer.wrap(byteArrayOf(5, 6, 7, 8)), 2, 1)
        assertArrayEquals(byteArrayOf(1, 5, 2, 6, 3, 7, 4, 8), planar.chroma)
    }

    /** A dark data row or column is as long as a side of the frame and must not be taken for one. */
    @Test fun dataRowsAreNotFrameSides() {
        for ((rows, columns) in listOf(4 to 6, 6 to 4, 3 to 7, 5 to 5, 4 to 5)) for (number in 1..9999 step 37) {
            val payload = number.toString(2).padStart(14, '0')
            val code = ReferenceRaster.render(Open3DPC.encode(payload, rows, columns), 24)
            val pad = 12
            val width = code.width + 2 * pad
            val height = code.height + 2 * pad
            val pixels = ByteArray(width * height * 4) { -1 }
            for (y in 0 until code.height) System.arraycopy(code.rgba, y * code.width * 4, pixels, ((y + pad) * width + pad) * 4, code.width * 4)
            assertEquals("$number on $rows x $columns", payload, LatticeSampler.analyze(Raster(pixels, width, height, width * 4)).payload)
        }
    }
}
