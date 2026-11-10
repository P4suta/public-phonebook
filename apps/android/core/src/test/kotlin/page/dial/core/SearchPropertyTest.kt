package page.dial.core

import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Test

class SearchPropertyTest {
    private val forms = SearchText(listOf("9ad9:9ad8"))

    @Test
    fun normalizationIsIdempotentAcrossSeededUnicodeInputs() {
        val random = Random(0x53454152)
        val alphabet =
            listOf(
                "Ａ",
                "a",
                "カ",
                "ｶﾞ",
                "\u3099",
                "髙",
                "📞",
                "\u2007",
                "\uFE0F",
                "\uDB40\uDDEF",
                "ー",
                "\n",
            )
        repeat(4096) {
            val input =
                List(random.nextInt(0, 40)) { alphabet[random.nextInt(alphabet.size)] }
                    .joinToString("")
            val normalized = forms.form(input)
            assertEquals(input, normalized, forms.form(normalized))
            assertEquals(forms.words(input), forms.words(normalized))
        }
    }

    @Test
    fun selectorEndpointsAndAdjacentCodePointsStayDistinct() {
        for (point in listOf(0xfe00, 0xfe0f, 0xe0100, 0xe01ef)) {
            assertEquals(listOf("ab"), forms.words("a" + String(Character.toChars(point)) + "b"))
        }
        for (point in listOf(0xfdff, 0xfe10, 0xe00ff, 0xe01f0)) {
            val value = String(Character.toChars(point))
            val expected =
                java.text.Normalizer.normalize("a${value}b", java.text.Normalizer.Form.NFKC)
            assertEquals(listOf(expected), forms.words("a${value}b"))
        }
    }

    @Test
    fun allWordsMustMatchAndRegionOnlyMatchesKeepTheirRank() {
        assertEquals(-1, forms.rank("name", listOf("place"), ""))
        assertEquals(-1, forms.rank("name", listOf("place"), "missing"))
        assertEquals(3, forms.rank("name", listOf("place"), "place"))
        assertEquals(2, forms.rank("name", emptyList(), List(8) { "name" }.joinToString(" ")))
        assertEquals(-1, forms.rank("name", emptyList(), List(9) { "name" }.joinToString(" ")))
        assertEquals(3, forms.rank("name", listOf("place"), "name place"))
        assertEquals(-1, forms.rank("name", listOf("place"), "name absent"))
        assertEquals(0, forms.rank("name", emptyList(), "name"))
        assertEquals(1, forms.rank("name ending", emptyList(), "name"))
        assertEquals(2, forms.rank("begin name", emptyList(), "name"))
    }
}
