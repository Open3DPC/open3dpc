// Copyright 2026 Roman Simonov. Licensed under the Apache License, Version 2.0.

package io.github.romanaerl.open3dpc

import org.junit.Assert.assertEquals
import org.junit.Test

/** Every row reads the pinned number of codes and never a wrong payload. */
class SyntheticSweepTest {
    @Test fun everyRowReadsThePinnedCount() {
        val failures = ArrayList<String>()
        for ((label, expected, run) in SyntheticSweep.rows) {
            val result = run()
            println("sweep  %-34s %s  expected %d/40  %s".format(label, result, expected, result.rejections))
            if (result.decoded != expected || result.wrong != 0) failures += "$label: $result, expected $expected/40"
        }
        assertEquals(emptyList<String>(), failures)
    }
}
