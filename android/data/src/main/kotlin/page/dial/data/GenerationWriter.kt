package page.dial.data

import android.database.sqlite.SQLiteDatabase
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import page.dial.core.Contact
import page.dial.core.DirectoryLimits
import page.dial.core.IndexTerms
import page.dial.core.SearchText

internal class GenerationWriter(private val forms: SearchText) {
    fun build(directory: File, decoder: InputStream, entry: ArchiveEntry): ArchiveHeader {
        val database = File(directory, "directory.db")
        val header =
            SQLiteDatabase.openOrCreateDatabase(database, null).use { db ->
                schema(db)
                val header =
                    DatabaseTransaction(db).use { transaction ->
                        val imported = index(db, decoder, File(directory, "archive.tsv"), entry)
                        db.version = SearchOrder.SCHEMA_VERSION
                        db.execSQL("CREATE INDEX phone_number ON phones(number,contact)")
                        db.execSQL("CREATE INDEX contact_category ON contacts(category)")
                        transaction.commit()
                        imported
                    }
                db.rawQuery("PRAGMA integrity_check", null).use { cursor ->
                    requireDirectory(cursor.moveToFirst() && cursor.getString(0) == "ok")
                }
                header
            }
        FileOutputStream(database, true).use { it.fd.sync() }
        return header
    }

    private fun schema(db: SQLiteDatabase) {
        db.rawQuery("PRAGMA journal_mode=DELETE", null).use { it.moveToFirst() }
        db.execSQL("CREATE TABLE metadata(json TEXT NOT NULL)")
        db.execSQL(
            "CREATE TABLE contacts(" +
                "id INTEGER PRIMARY KEY, raw TEXT NOT NULL, name TEXT NOT NULL, " +
                "place TEXT NOT NULL, category TEXT NOT NULL, sort_name TEXT NOT NULL)",
        )
        db.execSQL("CREATE TABLE phones(number TEXT NOT NULL, contact INTEGER NOT NULL)")
        db.execSQL("CREATE VIRTUAL TABLE terms USING fts4(tokens, tokenize=simple)")
    }

    private fun index(
        db: SQLiteDatabase,
        input: InputStream,
        archive: File,
        entry: ArchiveEntry,
    ): ArchiveHeader =
        Lines(input).use { lines ->
            requireDirectory(lines.next() == ARCHIVE_SIGNATURE)
            val text =
                lines.next(DirectoryLimits.MAXIMUM_JSON_BYTES)
                    ?: throw InvalidDirectory("Missing archive header")
            val header = ArchiveHeader(parseObject(text))
            requireDirectory(header.snapshot == entry.snapshot && header.contacts == entry.contacts)
            db.execSQL("INSERT INTO metadata VALUES(?)", arrayOf(text))
            FileOutputStream(archive).use { output ->
                output.line(ARCHIVE_SIGNATURE)
                output.line(text)
                importRows(db, lines, output, header)
                output.fd.sync()
            }
            header
        }

    private fun importRows(
        db: SQLiteDatabase,
        lines: Lines,
        output: FileOutputStream,
        header: ArchiveHeader,
    ) {
        val prefectureCounts = LongArray(DirectoryLimits.PREFECTURE_COUNT + 1)
        var count = 0L
        var previous: ByteArray? = null
        RowStatements(db, forms).use { statements ->
            while (true) {
                checkInterruption()
                val line = lines.next() ?: break
                requireDirectory(count < header.contacts)
                val bytes = line.toByteArray()
                previous?.let { requireDirectory(compareBytes(it, bytes) <= 0) }
                previous = bytes
                val record = header.record(line, count)
                val region = ArchiveFields.parse(line)[ArchiveColumn.Region].take(2).toInt()
                prefectureCounts[region]++
                statements.insert(record, line)
                output.line(line)
                count++
            }
        }
        requireDirectory(
            count == header.contacts &&
                header.prefectures.all {
                    prefectureCounts[it.getString("code").toInt()] == it.getLong("contacts")
                },
        )
    }
}

private class RowStatements(db: SQLiteDatabase, private val forms: SearchText) : java.io.Closeable {
    private val contacts = db.compileStatement("INSERT INTO contacts VALUES(?,?,?,?,?,?)")
    private val phones = db.compileStatement("INSERT INTO phones VALUES(?,?)")
    private val terms = db.compileStatement("INSERT INTO terms(rowid,tokens) VALUES(?,?)")

    fun insert(record: Contact, line: String) {
        val name = forms.form(record.name)
        val place =
            listOf(record.prefecture, record.municipality, record.category.label).joinToString(
                " ",
            ) {
                forms.form(it)
            }
        contacts.bindLong(1, record.row)
        contacts.bindString(2, line)
        contacts.bindString(NAME_COLUMN, name)
        contacts.bindString(PLACE_COLUMN, place)
        contacts.bindString(CATEGORY_COLUMN, record.category.id)
        contacts.bindString(SORT_COLUMN, SearchOrder.key(record.name))
        contacts.executeInsert()
        terms.bindLong(1, record.row)
        terms.bindString(2, IndexTerms.tokens("$name $place").joinToString(" "))
        terms.executeInsert()
        record.phones.forEach {
            phones.bindString(1, it.number.value)
            phones.bindLong(2, record.row)
            phones.executeInsert()
        }
    }

    override fun close() {
        contacts.use { phones.use { terms.close() } }
    }

    companion object {
        private const val NAME_COLUMN = 3
        private const val PLACE_COLUMN = 4
        private const val CATEGORY_COLUMN = 5
        private const val SORT_COLUMN = 6
    }
}

internal fun FileOutputStream.line(text: String) {
    write(text.toByteArray())
    write('\n'.code)
}

internal fun checkInterruption() {
    if (Thread.currentThread().isInterrupted) throw java.io.InterruptedIOException()
}

private const val UNSIGNED_BYTE_MASK = 255

internal fun compareBytes(left: ByteArray, right: ByteArray): Int {
    for (index in 0 until minOf(left.size, right.size)) {
        val comparison =
            (left[index].toInt() and UNSIGNED_BYTE_MASK).compareTo(
                right[index].toInt() and UNSIGNED_BYTE_MASK,
            )
        if (comparison != 0) return comparison
    }
    return left.size.compareTo(right.size)
}
