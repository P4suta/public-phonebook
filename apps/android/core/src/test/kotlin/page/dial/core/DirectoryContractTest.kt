package page.dial.core

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DirectoryContractTest {
    @Test
    fun sharedSearchContract() {
        val contract = JSONObject(javaClass.getResource("/SearchContract.json")!!.readText())
        val variants = javaClass.getResource("/kanji-variants.txt")!!.readText()
        val search =
            SearchText(Regex("[0-9a-f]+:[0-9a-f]+").findAll(variants).map { it.value }.toList())
        val forms = contract.getJSONArray("words")
        for (index in 0 until forms.length()) {
            val row = forms.getJSONObject(index)
            val expected = row.getJSONArray("words")
            assertEquals(
                row.toString(),
                (0 until expected.length()).map { expected.getString(it) },
                search.words(row.getString("text")),
            )
        }
        val ranks = contract.getJSONArray("ranks")
        for (index in 0 until ranks.length()) {
            val row = ranks.getJSONObject(index)
            val places = row.getJSONArray("places")
            assertEquals(
                row.toString(),
                row.getInt("rank"),
                search.rank(
                    row.getString("name"),
                    (0 until places.length()).map { places.getString(it) },
                    row.getString("query"),
                ),
            )
        }
    }

    @Test
    fun validatedIdentifiersAndTelephoneInputs() {
        assertNull(SnapshotId.parse("../active"))
        assertNotNull(SnapshotId.parse("a".repeat(64)))
        assertEquals("+81312345678", CanonicalPhone.parse("０３（１２３４）５６７８")?.value)
        assertEquals("+81312345678", CanonicalPhone.parse("+81 3-1234-5678")?.value)
        for (input in
            listOf("110", "03ABC12345678", "tel:0312345678", "+1 234 567 8901", "0".repeat(81))) {
            assertNull(input, CanonicalPhone.parse(input))
        }
    }

    @Test
    fun publicationRequiresEveryValidation() {
        for (mask in 0 until 32) {
            val facts =
                ValidationFacts(
                    mask and 1 != 0,
                    mask and 2 != 0,
                    mask and 4 != 0,
                    mask and 8 != 0,
                    mask and 16 != 0,
                )
            assertEquals(mask == 31, SyncPolicy.admit(facts))
        }
    }

    @Test
    fun uncertainPublicationRequiresObservedCommit() {
        assertTrue(PublicationPolicy.canActivate(GenerationPhase.Indexed, true))
        assertFalse(PublicationPolicy.canActivate(GenerationPhase.Receiving, true))
        assertFalse(PublicationPolicy.canActivate(GenerationPhase.Uncertain, true))
        assertFalse(PublicationPolicy.canActivate(GenerationPhase.Indexed, false))
        assertEquals(
            "saved",
            PublicationPolicy.select("saved", "candidate", GenerationPhase.Uncertain, true, false),
        )
        assertEquals(
            "candidate",
            PublicationPolicy.select("saved", "candidate", GenerationPhase.Uncertain, true, true),
        )
        assertEquals(
            "saved",
            PublicationPolicy.select("saved", "candidate", GenerationPhase.Uncertain, false, true),
        )
    }

    @Test
    fun updateDueAndNetworkConstraints() {
        assertTrue(SyncPolicy.due(null, 0))
        assertFalse(SyncPolicy.due(0, 86_399))
        assertTrue(SyncPolicy.due(0, 86_400))
        assertFalse(SyncPolicy.due(Long.MAX_VALUE, 0))
        assertTrue(SyncPolicy.due(0, Long.MAX_VALUE))
        for (metered in listOf(false, true)) for (restricted in listOf(false, true)) {
            assertEquals(!metered && !restricted, SyncPolicy.transfer(metered, restricted))
        }
    }
}
