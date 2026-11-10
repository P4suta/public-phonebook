package page.dial.core

object IndexTerms {
    fun tokens(text: String): Set<String> {
        val points = text.codePoints().toArray()
        return buildSet {
            points.forEach { add("u${it.toString(DirectoryLimits.HEX_RADIX)}") }
            for (index in 0 until points.size - 1) {
                val left = points[index].toString(DirectoryLimits.HEX_RADIX)
                val right = points[index + 1].toString(DirectoryLimits.HEX_RADIX)
                add("b${left}x$right")
            }
        }
    }

    fun required(word: String): Set<String> =
        tokens(word).filterTo(linkedSetOf()) {
            it.startsWith(if (word.codePointCount(0, word.length) > 1) "b" else "u")
        }
}
