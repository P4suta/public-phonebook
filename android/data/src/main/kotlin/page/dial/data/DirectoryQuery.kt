package page.dial.data

import android.database.sqlite.SQLiteDatabase
import android.os.CancellationSignal
import page.dial.core.CanonicalPhone
import page.dial.core.Category
import page.dial.core.DirectoryLimits
import page.dial.core.IndexTerms
import page.dial.core.SearchGroup
import page.dial.core.SearchPage
import page.dial.core.SearchResults
import page.dial.core.SearchText

internal class DirectoryQuery
private constructor(
    clauses: List<String>,
    private val arguments: List<String>,
    private val ranking: Pair<String, List<String>>,
) {
    private val where = clauses.joinToString(" AND ")

    fun execute(
        db: SQLiteDatabase,
        header: ArchiveHeader,
        offset: Int,
        cancellation: CancellationSignal? = null,
    ): SearchPage {
        val count =
            db.rawQuery(
                    "SELECT count(*) FROM contacts c WHERE $where",
                    arguments.toTypedArray(),
                    cancellation,
                )
                .use {
                    requireDirectory(it.moveToFirst())
                    it.getLong(0)
                }
        val sql =
            "SELECT c.id,c.raw FROM contacts c WHERE $where " +
                "ORDER BY ${ranking.first},c.sort_name COLLATE BINARY,c.id LIMIT ${DirectoryLimits.SEARCH_PAGE_SIZE} OFFSET ?"
        val rows =
            db.rawQuery(
                    sql,
                    (arguments + ranking.second + offset.toString()).toTypedArray(),
                    cancellation,
                )
                .use { cursor ->
                    buildList {
                        while (cursor.moveToNext()) add(
                            header.record(cursor.getString(1), cursor.getLong(0))
                        )
                    }
                }
        return SearchPage(rows, count, header.snapshot)
    }

    fun preview(
        db: SQLiteDatabase,
        header: ArchiveHeader,
        cancellation: CancellationSignal?,
    ): SearchResults {
        val definitions =
            header.categories.associate {
                it.getString("id") to Category(it.getString("id"), it.getString("label"))
            }
        val groups = linkedMapOf<String, CategoryPreview>()
        val sql =
            "SELECT c.id,c.category FROM contacts c WHERE $where " +
                "ORDER BY ${ranking.first},c.sort_name COLLATE BINARY,c.id"
        db.rawQuery(sql, (arguments + ranking.second).toTypedArray(), cancellation).use { rows ->
            while (rows.moveToNext()) {
                checkInterruption()
                cancellation?.throwIfCanceled()
                val category = rows.getString(1)
                val group =
                    groups.getOrPut(category) {
                        CategoryPreview(
                            definitions[category] ?: throw InvalidDirectory("Unknown category")
                        )
                    }
                group.total++
                if (group.rows.size < DirectoryLimits.SEARCH_PREVIEW_SIZE)
                    group.rows.add(rows.getLong(0))
            }
        }
        val selected = groups.values.flatMap { it.rows }
        if (selected.isEmpty()) return SearchResults(emptyList(), header.snapshot)
        val contacts =
            db.rawQuery(
                    "SELECT id,raw FROM contacts WHERE id IN (${selected.joinToString(",") { "?" }})",
                    selected.map { it.toString() }.toTypedArray(),
                    cancellation,
                )
                .use { rows ->
                    buildMap {
                        while (rows.moveToNext()) {
                            val row = rows.getLong(0)
                            put(row, header.record(rows.getString(1), row))
                        }
                    }
                }
        return SearchResults(
            groups.values.map { group ->
                SearchGroup(group.category, group.rows.map { contacts.getValue(it) }, group.total)
            },
            header.snapshot,
        )
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

private class CategoryPreview(val category: Category) {
    val rows = mutableListOf<Long>()
    var total = 0L
}
