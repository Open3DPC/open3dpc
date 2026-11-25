// Copyright 2026 Roman Simonov. Licensed under the Apache License, Version 2.0.

package io.github.romanaerl.open3dpc

/**
 * A code found in one frame. Valid by its checksum; confirm it with [Open3DPCStabilizer] before acting.
 *
 * @property bits the payload as `0` and `1`. Its length is part of the meaning.
 * @property rows rows the code was printed with, after its rotation was undone.
 * @property columns columns it was printed with.
 * @property corners the area it was read from, slightly outside its frame, in frame pixels.
 * @property trackId the same number for one code followed over consecutive frames.
 */
data class Open3DPCReading(val bits: String, val rows: Int, val columns: Int, val corners: List<FramePoint>, val trackId: Long) {
    /** The payload as an unsigned integer, most significant bit first; null over 63 bits or when empty. */
    val value: Long? get() = if (bits.length in 1..63) bits.toLong(2) else null
}

/** Rows × columns of a code. */
data class Open3DPCGeometry(val rows: Int, val columns: Int) {
    val isValid get() = Open3DPC.valid(rows, columns)
    val payloadCapacity get() = Open3DPC.capacity(rows, columns)
}

/**
 * Finds Open3DPC codes in camera frames and images.
 *
 * Use one reader per camera session, always from one thread: it follows codes between frames and keeps
 * its buffers. One call can take longer than a frame interval; drop the frames that arrive meanwhile.
 *
 * @param payloadLengths payload lengths your application understands, null for any. Set it: fewer
 *   accepted lengths means fewer false reads.
 * @param geometries shapes your application prints, null for any valid one.
 */
class Open3DPCReader(
    private val payloadLengths: Set<Int>? = null,
    private val geometries: Set<Open3DPCGeometry>? = null,
) {
    private val decoder = Open3DPCFrameDecoder()

    /** Reads a frame. Pass the viewfinder as [roi]: it bounds the work and keeps neighbouring codes out. */
    fun read(frame: Open3DPCFrame, roi: FrameRect = frame.bounds): List<Open3DPCReading> =
        decoder.analyze(frame, roi).mapNotNull { found ->
            val bits = found.payload ?: return@mapNotNull null
            val geometry = Open3DPCGeometry(found.height ?: return@mapNotNull null, found.width ?: return@mapNotNull null)
            if (payloadLengths?.contains(bits.length) == false || geometries?.contains(geometry) == false) return@mapNotNull null
            Open3DPCReading(bits, geometry.rows, geometry.columns, found.corners, found.trackId)
        }
}

/**
 * Turns per-frame readings into one confirmed code: the same payload on the same track in two frames
 * close together. With several codes in view it confirms none.
 *
 * The checksum is short, so one frame is not enough to act on.
 */
class Open3DPCStabilizer {
    private var pending: Open3DPCReading? = null
    private var seen = 0
    private var lastSeen = 0L
    private var confirmed: Open3DPCReading? = null

    /** Feed every frame's readings, empty ones too, with a monotonic clock. Returns the confirmed code while it is in view. */
    fun observe(readings: List<Open3DPCReading>, nowMs: Long): Open3DPCReading? {
        if (readings.size > 1) { reset(); return null }
        readings.firstOrNull()?.let { reading ->
            val before = pending
            if (before != null && before.bits == reading.bits && before.trackId == reading.trackId &&
                nowMs > lastSeen && nowMs - lastSeen <= CONSISTENCY_MS) seen++ else { seen = 1; confirmed = null }
            pending = reading
            lastSeen = nowMs
            if (seen >= 2) confirmed = reading
        }
        if (pending == null || nowMs - lastSeen > RETENTION_MS) { reset(); return null }
        return confirmed
    }

    fun reset() { pending = null; seen = 0; confirmed = null }

    companion object {
        /** Two sightings further apart than this are not the same look at a code. */
        const val CONSISTENCY_MS = 450L
        /** How long a confirmed code survives frames in which it was not seen. */
        const val RETENTION_MS = 420L
    }
}

/**
 * Says once per session that the scene is too dark to read. It owns no camera and no clock; feed it
 * brightness samples and light the torch when it answers true. It never says when to turn it off: the
 * torch is what made the scene bright.
 */
class LowLightTorchPolicy(private val threshold: Double = DEFAULT_THRESHOLD) {
    private var darkSince: Long? = null
    private var samples = 0
    private var done = false

    fun shouldLight(brightness: Double, nowMs: Long, codeSeenAtMs: Long? = null, torchIsOn: Boolean): Boolean {
        if (!brightness.isFinite() || brightness > threshold) { darkSince = null; samples = 0; return false }
        val since = darkSince ?: nowMs.also { darkSince = it }
        samples++
        if (done || torchIsOn || samples < 8 || nowMs - since < 1000) return false
        if (codeSeenAtMs != null && nowMs - codeSeenAtMs < 2000) return false
        done = true
        return true
    }

    companion object {
        /** `Bv ≤ 0` is roughly `Ev100 ≤ 5`, an unlit room at night. A value from the scale, not calibrated. */
        const val DEFAULT_THRESHOLD = 0.0

        /** APEX brightness from `LENS_APERTURE`, `SENSOR_EXPOSURE_TIME` in seconds and `SENSOR_SENSITIVITY`. */
        fun brightness(aperture: Double, exposureSeconds: Double, iso: Double): Double? =
            if (listOf(aperture, exposureSeconds, iso).all { it.isFinite() && it > 0 })
                kotlin.math.log2(aperture * aperture / exposureSeconds) - kotlin.math.log2(iso / 100) - 5 else null
    }
}
