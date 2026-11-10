package page.dial.data

import android.util.AtomicFile
import java.io.Closeable
import java.io.File
import page.dial.core.GenerationPhase
import page.dial.core.PublicationPolicy

internal fun AtomicFile.replace(bytes: ByteArray) {
    val stream = startWrite()
    val rollback = Closeable { failWrite(stream) }
    var committed = false
    Closeable { if (!committed) rollback.close() }
        .use {
            stream.write(bytes)
            finishWrite(stream)
            committed = true
        }
}

internal class StagedGeneration(val directory: File) : Closeable {
    var phase = GenerationPhase.Receiving
        private set

    fun indexed() {
        check(phase == GenerationPhase.Receiving)
        phase = GenerationPhase.Indexed
    }

    fun activationStarted() {
        check(phase == GenerationPhase.Indexed)
        phase = GenerationPhase.Uncertain
    }

    fun activated() {
        check(phase == GenerationPhase.Uncertain)
        phase = GenerationPhase.Complete
    }

    override fun close() {
        if (PublicationPolicy.canDiscard(phase) && directory.exists())
            requireDirectory(directory.deleteRecursively())
    }
}

internal class DatabaseTransaction(private val db: android.database.sqlite.SQLiteDatabase) :
    Closeable {
    init {
        db.beginTransaction()
    }

    fun commit() = db.setTransactionSuccessful()

    override fun close() = db.endTransaction()
}
