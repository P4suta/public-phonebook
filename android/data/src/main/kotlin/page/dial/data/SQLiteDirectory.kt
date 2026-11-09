package page.dial.data

import android.os.CancellationSignal
import android.util.AtomicFile
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlin.concurrent.read
import kotlin.concurrent.write
import org.brotli.dec.BrotliInputStream
import page.dial.core.CanonicalPhone
import page.dial.core.Contact
import page.dial.core.PublicationPolicy
import page.dial.core.SearchPage
import page.dial.core.SearchResults
import page.dial.core.SearchText
import page.dial.core.SyncPolicy
import page.dial.core.SyncState
import page.dial.core.ValidationFacts

internal class RebuiltArchive(
    val file: File,
    val entry: ArchiveEntry,
    val bytes: Long,
    val digest: page.dial.core.SnapshotId,
)

internal enum class CleanupState {
    Complete,
    Deferred,
}

internal enum class ActivationOutcome {
    NotAttempted,
    Committed,
    Recovered,
    Uncertain,
}

internal class SQLiteDirectory(
    root: File,
    private val forms: SearchText,
    private val removeGeneration: (File) -> Boolean = { it.deleteRecursively() },
    private val writePointer: (AtomicFile, ByteArray) -> Unit = { file, bytes ->
        file.replace(bytes)
    },
    private val beforeActivation: () -> Unit = {},
) {
    private val generations = File(root, "generations").apply { mkdirs() }
    private val active = AtomicFile(File(root, "active"))
    private val gate = ReentrantReadWriteLock()
    private val reader = GenerationReader(generations, active, gate)
    private val importing = Any()
    @Volatile
    var cleanupState = CleanupState.Deferred
        private set

    @Volatile
    var activationOutcome = ActivationOutcome.NotAttempted
        private set

    fun current(): SyncState.Ready? = reader.read { _, header ->
        SyncState.Ready(header.snapshot, header.contacts)
    }

    fun activeArchive(): File? = gate.read {
        reader.currentName()?.let { File(generations, "$it/archive.tsv") }
    }

    fun install(input: File, entry: ArchiveEntry): SyncState.Ready {
        requireDirectory(input.length() == entry.bytes && FileDigest.sha256(input) == entry.sha256)
        return publish(input, entry, compressed = true)
    }

    fun install(rebuilt: RebuiltArchive): SyncState.Ready {
        requireDirectory(
            rebuilt.file.length() == rebuilt.bytes &&
                FileDigest.sha256(rebuilt.file) == rebuilt.digest
        )
        return publish(rebuilt.file, rebuilt.entry, compressed = false)
    }

    private fun publish(input: File, entry: ArchiveEntry, compressed: Boolean): SyncState.Ready =
        synchronized(importing) {
            val identity = "${entry.snapshot.value}-${entry.sha256.value}"
            val alreadyActive = gate.read {
                reader.currentName()?.let { it == identity || it.startsWith("$identity-") } == true
            }
            if (alreadyActive)
                return@synchronized current() ?: throw InvalidDirectory("Missing active generation")
            val name = "$identity-${UUID.randomUUID()}"
            StagedGeneration(File(generations, "pending-${UUID.randomUUID()}").apply { mkdirs() })
                .use { staged ->
                    val decoder =
                        if (compressed) BrotliInputStream(input.inputStream())
                        else input.inputStream()
                    val header = decoder.use {
                        GenerationWriter(forms).build(staged.directory, it, entry)
                    }
                    val facts =
                        ValidationFacts(
                            true,
                            true,
                            header.snapshot == entry.snapshot,
                            header.contacts == entry.contacts,
                            true,
                        )
                    val admitted = SyncPolicy.admit(facts)
                    requireDirectory(admitted)
                    staged.indexed()
                    beforeActivation()
                    activate(staged, name, admitted)
                    retryCleanup()
                    SyncState.Ready(header.snapshot, header.contacts)
                }
        }

    private fun activate(staged: StagedGeneration, name: String, admitted: Boolean) = gate.write {
        requireDirectory(PublicationPolicy.canActivate(staged.phase, admitted))
        val previous = reader.currentName()
        val destination = File(generations, name)
        requireDirectory(!destination.exists())
        staged.activationStarted()
        activationOutcome = ActivationOutcome.Uncertain
        requireDirectory(staged.directory.renameTo(destination))
        val failure =
            try {
                writePointer(active, GenerationPointer(name, previous).bytes())
                null
            } catch (error: IOException) {
                error
            }
        val observed =
            try {
                GenerationPointer.read(active)
            } catch (recovery: IOException) {
                if (failure != null) {
                    failure.addSuppressed(recovery)
                    throw failure
                }
                throw recovery
            }
        val selected =
            PublicationPolicy.select(
                previous,
                name,
                staged.phase,
                admitted,
                observed?.current == name,
            )
        if (selected != name)
            throw failure ?: InvalidDirectory("Generation activation is unconfirmed")
        activationOutcome =
            if (failure == null) ActivationOutcome.Committed else ActivationOutcome.Recovered
        staged.activated()
    }

    fun retryCleanup(): Unit =
        synchronized(importing) {
            cleanupState =
                try {
                    val pointer = gate.read { GenerationPointer.read(active) }
                    cleanupGenerations(generations, pointer, removeGeneration)
                } catch (_: IOException) {
                    CleanupState.Deferred
                } catch (_: org.json.JSONException) {
                    CleanupState.Deferred
                } catch (_: SecurityException) {
                    CleanupState.Deferred
                }
        }

    fun search(
        query: String,
        category: String? = null,
        offset: Int = 0,
        cancellation: CancellationSignal? = null,
    ): SearchPage {
        val plan = DirectoryQuery.parse(query, category, offset, forms)
        return if (plan == null) SearchPage(emptyList(), 0, current()?.snapshot)
        else {
            prepareSearch(cancellation)
            reader.read { db, header -> plan.execute(db, header, offset, cancellation) }
                ?: SearchPage(emptyList(), 0, null)
        }
    }

    fun prepareSearch(cancellation: CancellationSignal? = null) = reader.prepareSearch(cancellation)

    fun preview(query: String, cancellation: CancellationSignal? = null): SearchResults {
        val plan = DirectoryQuery.parse(query, null, 0, forms)
        if (plan == null) return SearchResults(emptyList(), current()?.snapshot)
        prepareSearch(cancellation)
        return reader.read { db, header -> plan.preview(db, header, cancellation) }
            ?: SearchResults(emptyList(), null)
    }

    fun find(phone: CanonicalPhone, cancellation: CancellationSignal? = null): Contact? =
        reader.read { db, header ->
            val sql =
                "SELECT c.id,c.raw FROM phones p JOIN contacts c ON p.contact=c.id " +
                    "WHERE p.number=? ORDER BY c.id LIMIT 1"
            db.rawQuery(sql, arrayOf(phone.value), cancellation).use {
                if (it.moveToFirst()) header.record(it.getString(1), it.getLong(0)) else null
            }
        }
}

private fun cleanupGenerations(
    generations: File,
    pointer: GenerationPointer?,
    remove: (File) -> Boolean,
): CleanupState {
    val protected = pointer?.let { listOfNotNull(it.current, it.previous).toSet() }
    val results = protected?.let { names ->
        generations
            .listFiles()
            ?.filter { it.name !in names }
            ?.map {
                try {
                    remove(it)
                } catch (_: SecurityException) {
                    false
                }
            }
    }
    return if (results != null && results.all { it }) CleanupState.Complete
    else CleanupState.Deferred
}
