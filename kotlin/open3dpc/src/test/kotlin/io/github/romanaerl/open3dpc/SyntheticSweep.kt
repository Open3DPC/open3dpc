// Copyright 2026 Roman Simonov. Licensed under the Apache License, Version 2.0.

package io.github.romanaerl.open3dpc

internal class Sweep(var decoded: Int = 0, var total: Int = 0, var wrong: Int = 0) {
    val rejections = sortedMapOf<String, Int>()
    fun note(reason: String) { rejections[reason] = (rejections[reason] ?: 0) + 1 }
    override fun toString() = "$decoded/$total" + if (wrong > 0) " WRONG $wrong" else ""
}

/** Sweeps over synthetic images; the counts pin the behaviour, so that a change cannot go unnoticed. */
internal object SyntheticSweep {
    private val vectors = testCodes()
    private fun score(result: Sweep, vector: TestCode, outcome: RasterOutcome) {
        result.total++
        when {
            outcome.stage == Open3DPCStage.Validated && outcome.payload == vector.payload -> result.decoded++
            outcome.stage == Open3DPCStage.Validated -> { result.wrong++; result.note("WRONG ${outcome.height}x${outcome.width}") }
            else -> result.note(outcome.reason.name.takeIf { it != "None" } ?: outcome.stage.name)
        }
    }

    fun sweep(module: Int, shrunken: Boolean = false, pair: MaterialPair = MaterialPair.DarkOnLight, rotations: Int = 0) = Sweep().also { result ->
        for (vector in vectors) {
            var raster = ReferenceRaster.render(vector.matrix, module, shrunken, pair)
            repeat(rotations) { raster = raster.rotatedClockwise() }
            score(result, vector, LatticeSampler.analyze(raster.toRaster()))
        }
    }

    fun perspective(
        module: Int, pose: PlanePose, quadError: Double = 0.0, quadDilation: Double = 0.0, blurSigma: Double = 0.0,
        margin: Double? = null, gates: Open3DPCGates = Open3DPCGates.Strict,
    ) = Sweep().also { result ->
        for ((index, vector) in vectors.withIndex()) {
            val raster = ReferenceRaster.render(vector.matrix, module)
            var (frame, quad) = raster.projected(pose)
            if (blurSigma > 0) frame = frame.blurred(blurSigma)
            val observed = Perspective.distance(quad[0], quad[1]) / (vector.matrix[0].length + 2)
            if (quadDilation != 0.0) quad = ReferenceRaster.dilated(quad, quadDilation, observed)
            if (quadError > 0) quad = ReferenceRaster.jittered(quad, quadError, observed, index)
            if (margin != null) quad = Perspective.expanded(quad, margin)
            val rectified = frame.rectified(quad)
            if (rectified == null) { result.total++; result.note("no rectification"); continue }
            score(result, vector, LatticeSampler.analyze(rectified.toRaster(), gates))
        }
    }

    /** Label to the number of codes read out of forty. */
    val rows: List<Triple<String, Int, () -> Sweep>> = buildList {
        for (module in listOf(6, 8)) add(Triple("M = $module px", 38) { sweep(module) })
        for (module in listOf(10, 12, 14, 16, 20, 24, 28, 40)) add(Triple("M = $module px", 40) { sweep(module) })
        add(Triple("0.7M cells at M = 14", 40) { sweep(14, shrunken = true) })
        for (rotation in 0..3) add(Triple("rotation ${rotation * 90}", 40) { sweep(20, rotations = rotation) })
        add(Triple("light on dark", 40) { sweep(20, pair = MaterialPair.LightOnDark) })
        add(Triple("chromatic pair", 40) { sweep(20, pair = MaterialPair.Filament) })
        for ((label, pose) in listOf(
            "square-on" to PlanePose(), "yaw 10" to PlanePose(10.0), "yaw 20" to PlanePose(20.0), "yaw 30" to PlanePose(30.0), "yaw 40" to PlanePose(40.0),
            "pitch 20" to PlanePose(pitch = 20.0), "pitch 30" to PlanePose(pitch = 30.0), "yaw 20 pitch 20" to PlanePose(20.0, 20.0),
            "roll 12" to PlanePose(roll = 12.0), "yaw 20 roll 12" to PlanePose(20.0, roll = 12.0),
        )) add(Triple(label, 40) { perspective(20, pose) })
        val yaw20 = PlanePose(20.0)
        for ((error, count) in listOf(0.0 to 40, 0.1 to 36, 0.25 to 10, 0.5 to 0, 0.75 to 1, 1.0 to 0))
            add(Triple("corners off by $error M", count) { perspective(20, yaw20, quadError = error) })
        for ((dilation, count) in listOf(-0.5 to 0, -0.3 to 0, -0.25 to 0, -0.2 to 39, -0.15 to 38, -0.1 to 40, 0.0 to 40, 0.25 to 40, 0.5 to 38, 1.0 to 40, 1.5 to 40, 2.0 to 40, 4.0 to 0))
            add(Triple("corners %+.2f M".format(dilation), count) { perspective(20, yaw20, quadDilation = dilation) })
        for ((sigma, count) in listOf(0.0 to 40, 0.1 to 40, 0.2 to 38, 0.3 to 3, 0.5 to 0))
            add(Triple("sigma $sigma M", count) { perspective(20, yaw20, blurSigma = sigma * 20) })
        add(Triple("corners 0.25 M + sigma 0.20 M", 12) { perspective(20, yaw20, quadError = 0.25, blurSigma = 4.0) })
    }
}
