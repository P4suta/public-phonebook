package page.dial.core

import java.math.BigInteger
import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PolicyPropertyTest {
    @Test
    fun transferAndCopyDecisionsMatchUnboundedArithmetic() {
        val random = Random(SEED)
        val edges = listOf(Long.MIN_VALUE, -1L, 0L, 1L, 2L, Long.MAX_VALUE - 1, Long.MAX_VALUE)
        val triples = edges.flatMap { a ->
            edges.flatMap { b -> edges.map { c -> Triple(a, b, c) } }
        }
        val inputs =
            triples +
                List(SAMPLES) { Triple(random.nextLong(), random.nextLong(), random.nextLong()) }
        for ((start, count, limit) in inputs) {
            val end = BigInteger.valueOf(start) + BigInteger.valueOf(count)
            assertEquals(
                "$start + $count <= $limit",
                start >= 0 && count >= 0 && end <= BigInteger.valueOf(limit),
                TransferPolicy.chunk(start, count, limit),
            )
            assertEquals(
                start >= 0 && count >= 1 && end <= BigInteger.valueOf(limit),
                TransferPolicy.copy(start, count, limit),
            )
        }
    }

    @Test
    fun everyPublicationStatePreservesOnlyAnObservedValidatedCommit() {
        for (active in listOf(null, "saved")) {
            for (phase in GenerationPhase.entries) {
                for (valid in listOf(false, true)) {
                    for (observed in listOf(false, true)) {
                        val committed =
                            phase == GenerationPhase.Complete ||
                                (phase == GenerationPhase.Uncertain && observed)
                        assertEquals(
                            if (valid && committed) "candidate" else active,
                            PublicationPolicy.select(active, "candidate", phase, valid, observed),
                        )
                        assertEquals(
                            phase == GenerationPhase.Indexed && valid,
                            PublicationPolicy.canActivate(phase, valid),
                        )
                        assertEquals(
                            phase in listOf(GenerationPhase.Receiving, GenerationPhase.Indexed),
                            PublicationPolicy.canDiscard(phase),
                        )
                    }
                }
            }
        }
    }

    @Test
    fun callerAndUpdateClockBoundariesRejectRegressionAndOverflow() {
        val times = listOf(Long.MIN_VALUE, -1L, 0L, 1L, 999L, 1000L, 86399L, 86400L, Long.MAX_VALUE)
        for (start in times) for (now in times) {
            val elapsed = BigInteger.valueOf(now) - BigInteger.valueOf(start)
            assertEquals(
                start >= 0 && now >= start && elapsed >= BigInteger.valueOf(86400),
                SyncPolicy.due(start, now),
            )
            for (found in listOf(false, true)) for (held in listOf(false, true)) {
                assertEquals(
                    start >= 0 &&
                        now >= start &&
                        elapsed < BigInteger.valueOf(1000) &&
                        found &&
                        held,
                    CallerPolicy.display(start, now, found, held),
                )
            }
        }
        for (now in times) assertTrue(SyncPolicy.due(null, now))
    }

    @Test
    fun rankChecksEveryAdmittedWordCountAndMatchDistribution() {
        for (words in 1..DirectoryLimits.MAXIMUM_QUERY_WORDS) {
            for (named in 0..words) for (placed in 0..words - named) {
                for (nameRank in 0..2) {
                    val expected = expectedRank(words, named, placed, nameRank)
                    assertEquals(expected, WordPolicy.rank(words, named, placed, nameRank))
                }
            }
        }
    }

    private fun expectedRank(words: Int, named: Int, placed: Int, nameRank: Int): Int? =
        when {
            named + placed != words -> null
            named != words -> 3
            words == 1 -> nameRank
            else -> 2
        }

    @Test
    fun paginationAndJsonDepthCoverEveryBoundary() {
        for (more in listOf(false, true)) for (sameQuery in listOf(false, true)) assertEquals(
            more && sameQuery,
            PagePolicy.canAppend(more, sameQuery),
        )
        for (more in listOf(false, true)) {
            for (previous in listOf(null, "a", "b")) for (received in listOf(null, "a", "b")) {
                assertEquals(
                    more && previous != received,
                    PagePolicy.restart(more, previous, received),
                )
            }
        }
        for (depth in listOf(Int.MIN_VALUE, -1, 0, 1, 31, 32, 33, Int.MAX_VALUE)) {
            assertEquals(depth in 0..31, JsonPolicy.validDepth(depth))
        }
    }

    @Test
    fun phoneFormattingRoundTripsAndRejectsEmbeddedInstructions() {
        val random = Random(SEED)
        repeat(SAMPLES) {
            val national =
                "0${random.nextInt(1, 10)}" + List(8) { random.nextInt(10) }.joinToString("")
            val canonical = requireNotNull(CanonicalPhone.parse(national))
            assertEquals("+81" + national.drop(1), canonical.value)
            assertEquals(canonical, CanonicalPhone.parse(canonical.value))
            assertEquals(
                canonical,
                CanonicalPhone.parse(
                    national.map { if (it.isDigit()) it + ('０' - '0') else it }.joinToString(""),
                ),
            )
            for (marker in listOf(";", "#", "*", "\n", "a")) {
                assertNull(CanonicalPhone.parse(national.take(5) + marker + national.drop(5)))
            }
        }
        assertNull(CanonicalPhone.parse(""))
        assertNull(CanonicalPhone.parse("+810312345678"))
        assertFalse(SnapshotId.parse("A".repeat(64)) != null)
    }

    @Test
    fun indexTermsPreserveUnicodeCodePointsAndRequiredSubstrings() {
        assertEquals(emptySet<String>(), IndexTerms.tokens(""))
        assertEquals(setOf("u1f4de"), IndexTerms.required("📞"))
        assertEquals(setOf("b1f4dex61"), IndexTerms.required("📞a"))
        assertEquals(setOf("u61", "u62", "b61x62", "b62x61"), IndexTerms.tokens("aba"))
        val random = Random(SEED)
        val alphabet = listOf("a", "あ", "📞", "𠮷", " ")
        repeat(SAMPLES) {
            val parts = List(random.nextInt(1, 12)) { alphabet[random.nextInt(alphabet.size)] }
            val start = random.nextInt(parts.size)
            val end = random.nextInt(start + 1, parts.size + 1)
            assertTrue(
                IndexTerms.tokens(parts.joinToString(""))
                    .containsAll(IndexTerms.required(parts.subList(start, end).joinToString(""))),
            )
        }
    }

    companion object {
        private const val SEED = 0x50484f4e
        private const val SAMPLES = 4096
    }
}
