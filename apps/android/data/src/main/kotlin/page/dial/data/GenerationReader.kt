package page.dial.data

import android.database.sqlite.SQLiteDatabase
import android.os.CancellationSignal
import android.util.AtomicFile
import java.io.File
import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlin.concurrent.read
import kotlin.concurrent.write
import org.json.JSONObject

internal class GenerationReader(
    private val generations: File,
    private val active: AtomicFile,
    private val gate: ReentrantReadWriteLock,
) {
    @Volatile private var cached: Pair<String, ArchiveHeader>? = null
    private var orderedGeneration: String? = null

    fun currentName(): String? = GenerationPointer.read(active)?.current

    fun <T> read(block: (SQLiteDatabase, ArchiveHeader) -> T): T? = gate.read {
        val name = currentName() ?: return@read null
        SQLiteDatabase.openDatabase(
                File(generations, "$name/directory.db").path,
                null,
                SQLiteDatabase.OPEN_READONLY,
            )
            .use { db ->
                val header =
                    cached?.takeIf { it.first == name }?.second
                        ?: db.rawQuery("SELECT json FROM metadata", null).use { rows ->
                            requireDirectory(rows.moveToFirst())
                            ArchiveHeader(JSONObject(rows.getString(0))).also {
                                cached = name to it
                            }
                        }
                block(db, header)
            }
    }

    fun prepareSearch(cancellation: CancellationSignal?) = gate.write {
        cancellation?.throwIfCanceled()
        val name = currentName() ?: return@write
        if (orderedGeneration == name) return@write
        SQLiteDatabase.openDatabase(
                File(generations, "$name/directory.db").path,
                null,
                SQLiteDatabase.OPEN_READWRITE,
            )
            .use { SearchOrder.migrate(it, cancellation) }
        orderedGeneration = name
    }
}
