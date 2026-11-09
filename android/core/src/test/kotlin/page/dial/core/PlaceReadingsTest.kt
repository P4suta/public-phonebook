package page.dial.core

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaceReadingsTest {
    private val forms = SearchText(emptyList())
    private val source = JSONObject(javaClass.getResource("/PlaceReadings.json")!!.readText())
    private val prefectures =
        source.getJSONArray("prefectures").let { rows ->
            (0 until rows.length()).map { rows.getJSONArray(it).getString(1) }
        }
    private val categories =
        source.getJSONObject("categories").let { rows ->
            rows.keys().asSequence().associateWith { id -> strings(rows.getJSONArray(id)) }
        }
    private val readings = PlaceReadings(prefectures, categories, forms::form)

    @Test
    fun sharedReadingContract() {
        val cases = JSONArray(javaClass.getResource("/PlaceReadingContract.json")!!.readText())
        for (index in 0 until cases.length()) {
            val row = cases.getJSONObject(index)
            assertEquals(
                row.toString(),
                ReadingPlaces(
                    strings(row.getJSONArray("prefectures")),
                    strings(row.getJSONArray("categories")),
                ),
                readings.matching(forms.form(row.getString("text"))),
            )
        }
        prefectures.forEachIndexed { index, kana ->
            assertTrue(
                (index + 1).toString().padStart(2, '0') in
                    readings.matching(forms.form(kana)).prefectures
            )
        }
        categories.forEach { (id, values) ->
            values.forEach { assertTrue(id in readings.matching(forms.form(it)).categories) }
        }
    }

    @Test
    fun malformedReadingDocumentsAreRejected() {
        assertThrows(IllegalArgumentException::class.java) {
            PlaceReadings(prefectures.drop(1), categories, forms::form)
        }
        for (values in listOf(emptyList(), listOf("ト"), listOf("図書館"), List(9) { "トショカン" })) {
            assertThrows(IllegalArgumentException::class.java) {
                PlaceReadings(prefectures, mapOf("library" to values), forms::form)
            }
        }
        assertThrows(IllegalArgumentException::class.java) {
            PlaceReadings(prefectures, mapOf("library|medical" to listOf("トショカン")), forms::form)
        }
    }

    private fun strings(array: JSONArray): List<String> =
        (0 until array.length()).map { array.getString(it) }
}
