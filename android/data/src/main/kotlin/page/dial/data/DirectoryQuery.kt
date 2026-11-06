package page.dial.data

import android.database.sqlite.SQLiteDatabase
import page.dial.core.CanonicalPhone
import page.dial.core.DirectoryLimits
import page.dial.core.IndexTerms
import page.dial.core.SearchPage
import page.dial.core.SearchText

internal class DirectoryQuery
private constructor(
    private val clauses: List<String>,
    private val arguments: List<String>,
    private val ranking: Pair<String, List<String>>,
) {
    fun execute(db: SQLiteDatabase, header: ArchiveHeader, offset: Int): SearchPage {
        val where = clauses.joinToString(" AND ")
        val count =
            db.rawQuery("SELECT count(*) FROM contacts c WHERE $where", arguments.toTypedArray())
                .use {
                    requireDirectory(it.moveToFirst())
                    it.getLong(0)
                }
        val sql =
            "SELECT c.id,c.raw FROM contacts c WHERE $where " +
                "ORDER BY ${ranking.first},c.name COLLATE BINARY,c.id LIMIT ${DirectoryLimits.SEARCH_PAGE_SIZE} OFFSET ?"
        val rows =
            db.rawQuery(sql, (arguments + ranking.second + offset.toString()).toTypedArray()).use {
                cursor ->
                buildList {
                    while (cursor.moveToNext()) add(
                        header.record(cursor.getString(1), cursor.getLong(0))
                    )
                }
            }
        return SearchPage(rows, count, header.snapshot)
    }

    companion object {
        fun parse(
            query: String,
            category: String?,
            offset: Int,
            forms: SearchText,
        ): DirectoryQuery? {
            val phone = CanonicalPhone.parse(query)
            val words = forms.words(query)
            val admitted =
                query.toByteArray().size <= DirectoryLimits.MAXIMUM_QUERY_BYTES &&
                    offset in 0..DirectoryLimits.MAXIMUM_CONTACTS &&
                    (phone != null || words.size in 1..DirectoryLimits.MAXIMUM_QUERY_WORDS)
            if (!admitted) return null
            val clauses = arrayListOf<String>()
            val arguments = arrayListOf<String>()
            if (phone != null) {
                clauses += "c.id IN (SELECT contact FROM phones WHERE number=?)"
                arguments += phone.value
            } else {
                clauses += "c.id IN (SELECT rowid FROM terms WHERE tokens MATCH ?)"
                arguments += words.flatMap(IndexTerms::required).distinct().joinToString(" ")
                words.forEach {
                    clauses += "(instr(c.name,?)>0 OR instr(c.place,?)>0)"
                    arguments += listOf(it, it)
                }
            }
            category?.let {
                clauses += "c.category=?"
                arguments += it
            }
            val ranking =
                if (phone != null) "CASE WHEN 1 THEN 0 END" to emptyList() else rank(words)
            return DirectoryQuery(clauses, arguments, ranking)
        }

        private fun rank(words: List<String>): Pair<String, List<String>> {
            val missing = words.joinToString(" OR ") { "instr(c.name,?)=0" }
            return if (words.size == 1) {
                "CASE WHEN $missing THEN 3 WHEN c.name=? THEN 0 WHEN instr(c.name,?)=1 THEN 1 ELSE 2 END" to
                    (words + words + words)
            } else "CASE WHEN $missing THEN 3 ELSE 2 END" to words
        }
    }
}
