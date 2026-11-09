package page.dial.core

data class ReadingPlaces(val prefectures: List<String>, val categories: List<String>) {
    val isEmpty: Boolean
        get() = prefectures.isEmpty() && categories.isEmpty()
}

class PlaceReadings(
    prefectures: List<String>,
    categories: Map<String, List<String>>,
    form: (String) -> String,
) {
    private val prefectureForms: List<Pair<String, String>>
    private val categoryForms: Map<String, List<String>>

    init {
        require(prefectures.size == PREFECTURE_COUNT)
        require(prefectures.all(::validKana))
        require(categories.keys.all { it.matches(Regex("[a-z][a-z0-9_]{0,63}")) })
        require(categories.values.all { it.size in 1..MAXIMUM_ALIASES && it.all(::validKana) })
        prefectureForms = prefectures.mapIndexed { index, kana ->
            (index + 1).toString().padStart(2, '0') to form(kana)
        }
        categoryForms = categories.mapValues { (_, values) -> values.map(form) }
    }

    fun matching(word: String): ReadingPlaces {
        if (!word.matches(Regex("[ぁ-ゖゝゞ-]{2,}")) || word.none { it in 'ぁ'..'ゖ' || it in "ゝゞ" })
            return ReadingPlaces(emptyList(), emptyList())
        return ReadingPlaces(
            prefectureForms.filter { it.second.startsWith(word) }.map { it.first },
            categoryForms
                .filterValues { values -> values.any { it.startsWith(word) } }
                .keys
                .sorted(),
        )
    }

    private fun validKana(value: String): Boolean =
        value.length in 2..MAXIMUM_READING_LENGTH && value.matches(Regex("[ァ-ヶー]+"))

    companion object {
        private const val PREFECTURE_COUNT = 47
        private const val MAXIMUM_ALIASES = 8
        private const val MAXIMUM_READING_LENGTH = 128
    }
}
