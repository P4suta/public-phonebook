package page.dial.core

import java.text.Normalizer
import java.util.Locale

@JvmInline
value class SnapshotId private constructor(val value: String) {
    companion object {
        private val spelling = Regex("[a-f0-9]{64}")

        fun parse(value: String): SnapshotId? =
            if (value.matches(spelling)) SnapshotId(value) else null
    }
}

@JvmInline
value class CanonicalPhone private constructor(val value: String) {
    companion object {
        private val nationalSpelling = Regex("0[1-9][0-9]{8,9}")

        fun parse(input: String): CanonicalPhone? {
            val text = input.trim()
            val permitted = "0123456789０１２３４５６７８９+＋()（）.． \t\u00a0\u3000-－‐‑‒–—―−⁻₋﹣ーｰ"
            if (
                text.length > DirectoryLimits.MAXIMUM_PHONE_INPUT ||
                    text.isEmpty() ||
                    text.any { it !in permitted }
            )
                return null
            val compact =
                Normalizer.normalize(text, Normalizer.Form.NFKC).filter { it !in " \t().-‐‑‒–—―−ー" }
            val national =
                if (compact.startsWith(DirectoryLimits.COUNTRY_PREFIX))
                    "0" + compact.drop(DirectoryLimits.COUNTRY_PREFIX.length)
                else compact
            return if (national.matches(nationalSpelling)) CanonicalPhone("+81" + national.drop(1))
            else null
        }
    }
}

data class Phone(val number: CanonicalPhone, val display: String)

data class Category(val id: String, val label: String)

data class Contact(
    val snapshot: SnapshotId,
    val row: Long,
    val category: Category,
    val prefecture: String,
    val municipality: String,
    val name: String,
    val address: String,
    val phones: List<Phone>,
    val website: String?,
    val sourceUrl: String,
    val publisher: String,
    val license: String,
    val licenseUrl: String,
    val retrievedAt: String,
)

data class SearchPage(val contacts: List<Contact>, val total: Long, val snapshot: SnapshotId?)

data class SearchGroup(val category: Category, val contacts: List<Contact>, val total: Long)

data class SearchResults(val groups: List<SearchGroup>, val snapshot: SnapshotId?) {
    val total: Long
        get() = groups.sumOf { it.total }
}

sealed interface SyncState {
    data object Preparing : SyncState

    data class Ready(val snapshot: SnapshotId, val contacts: Long) : SyncState

    data class Updating(val saved: Ready) : SyncState

    data class Failed(val saved: Ready?) : SyncState
}

interface DirectoryRepository {
    suspend fun prepare(): SyncState.Ready

    suspend fun preview(query: String): SearchResults

    suspend fun search(query: String, category: String? = null, offset: Int = 0): SearchPage

    suspend fun find(phone: CanonicalPhone): Contact?

    suspend fun refresh(): SyncState.Ready
}

data class ValidationFacts(
    val length: Boolean,
    val digest: Boolean,
    val snapshot: Boolean,
    val rows: Boolean,
    val complete: Boolean,
)

object SyncPolicy {
    const val UPDATE_INTERVAL_SECONDS = 86400L

    fun admit(facts: ValidationFacts): Boolean =
        facts.length && facts.digest && facts.snapshot && facts.rows && facts.complete

    fun transfer(metered: Boolean, restricted: Boolean): Boolean = !metered && !restricted

    fun due(last: Long?, now: Long): Boolean =
        last == null || (last >= 0 && now >= last && now - last >= UPDATE_INTERVAL_SECONDS)
}

class SearchText(pairs: List<String>) {
    private val standardSelectors = FIRST_STANDARD_SELECTOR..LAST_STANDARD_SELECTOR
    private val supplementarySelectors = FIRST_SUPPLEMENTARY_SELECTOR..LAST_SUPPLEMENTARY_SELECTOR
    private val whitespace =
        Regex("[\\s\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]+")
    private val dashes =
        setOf(
            0x30fc,
            0xff70,
            0x2010,
            0x2011,
            0x2012,
            0x2013,
            0x2014,
            0x2015,
            0x2212,
            0xfe63,
            0xff0d,
        )
    private val variants: Map<Int, Int> = pairs.associate { pair ->
        val (from, to) = pair.split(':')
        from.toInt(DirectoryLimits.HEX_RADIX) to to.toInt(DirectoryLimits.HEX_RADIX)
    }

    fun words(text: String): List<String> {
        val selected = StringBuilder()
        text
            .codePoints()
            .filter { it !in standardSelectors && it !in supplementarySelectors }
            .forEach { selected.appendCodePoint(it) }
        val normalized = Normalizer.normalize(selected, Normalizer.Form.NFKC).lowercase(Locale.ROOT)
        val folded = StringBuilder()
        normalized.codePoints().forEach { point ->
            val kana =
                if (point in 0x30a1..0x30f6 || point == 0x30fd || point == 0x30fe) point - 0x60
                else point
            val mapped =
                when {
                    kana == 0x3095 -> 0x304b
                    kana == 0x3096 -> 0x3051
                    kana in dashes -> 0x2d
                    else -> variants[kana] ?: kana
                }
            folded.appendCodePoint(mapped)
        }
        return Normalizer.normalize(folded, Normalizer.Form.NFC).split(whitespace).filter {
            it.isNotEmpty()
        }
    }

    fun form(text: String): String = words(text).joinToString(" ")

    fun rank(name: String, places: List<String>, query: String): Int {
        val words = words(query)
        if (words.isEmpty() || words.size > DirectoryLimits.MAXIMUM_QUERY_WORDS) return -1
        val folded = form(name)
        val regions = places.map(::form)
        val named = words.count { it in folded }
        val placed = words.count { word -> word !in folded && regions.any { word in it } }
        val nameRank =
            if (folded == words.first()) 0 else if (folded.startsWith(words.first())) 1 else 2
        return WordPolicy.rank(words.size, named, placed, nameRank) ?: -1
    }

    companion object {
        private const val FIRST_STANDARD_SELECTOR = 0xfe00
        private const val LAST_STANDARD_SELECTOR = 0xfe0f
        private const val FIRST_SUPPLEMENTARY_SELECTOR = 0xe0100
        private const val LAST_SUPPLEMENTARY_SELECTOR = 0xe01ef
    }
}
