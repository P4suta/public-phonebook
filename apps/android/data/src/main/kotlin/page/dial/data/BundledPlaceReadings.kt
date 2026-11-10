package page.dial.data

import org.json.JSONObject
import page.dial.core.PlaceReadings
import page.dial.core.SearchText

internal object BundledPlaceReadings {
    fun load(forms: SearchText): PlaceReadings {
        val stream =
            javaClass.getResourceAsStream("/PlaceReadings.json")
                ?: throw InvalidDirectory("Missing place readings")
        val source = stream.bufferedReader().use { JSONObject(it.readText()) }
        val prefectures = source.getJSONArray("prefectures")
        val categories = source.getJSONObject("categories")
        return PlaceReadings(
            (0 until prefectures.length()).map { prefectures.getJSONArray(it).getString(1) },
            categories.keys().asSequence().associateWith { id ->
                val values = categories.getJSONArray(id)
                (0 until values.length()).map { values.getString(it) }
            },
            forms::form,
        )
    }
}
