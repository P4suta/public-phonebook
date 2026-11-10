package page.dial.data

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import page.dial.core.CanonicalPhone

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class PublicationTest {
    private val fixtures =
        JSONArray(File(requireNotNull(System.getProperty("phonebook.fixture"))).readText())
    private val context = ApplicationProvider.getApplicationContext<Context>()

    private fun fixture(revision: String, archive: Boolean): JSONObject =
        (0 until fixtures.length())
            .map { fixtures.getJSONObject(it) }
            .first {
                it.getString("revision") == revision &&
                    it.getString("path").endsWith("directory.tsv.br") == archive &&
                    (archive || it.getString("path") == "/api/datasets")
            }

    private fun archive(root: File, revision: String): Pair<File, ArchiveEntry> {
        val entry =
            DatasetListing.parse(JSONObject(fixture(revision, false).getString("body"))).archive
        return File(root, "$revision.br").apply {
            writeBytes(Base64.getDecoder().decode(fixture(revision, true).getString("body")))
        } to entry
    }

    @Test
    fun abortRetainsUncertainAndCommittedCandidates() {
        val root = File(context.cacheDir, "abort-${System.nanoTime()}").apply { mkdirs() }
        for (step in 0..3) {
            val directory = File(root, "candidate-$step").apply { mkdirs() }
            val staged = StagedGeneration(directory)
            if (step >= 1) staged.indexed()
            if (step >= 2) staged.activationStarted()
            if (step >= 3) staged.activated()
            staged.close()
            assertEquals(step >= 2, directory.exists())
        }
    }

    @Test
    fun postCommitCleanupFailureKeepsTheNewGenerationUsable() {
        val root = File(context.cacheDir, "cleanup-${System.nanoTime()}").apply { mkdirs() }
        val baseline = archive(root, "baseline")
        val updated = archive(root, "updated")
        val forms = SearchForms.load()
        val original = SQLiteDirectory(root, forms)
        original.install(baseline.first, baseline.second)
        val orphan = File(root, "generations/pending-orphan").apply { mkdirs() }
        val store = SQLiteDirectory(root, forms, removeGeneration = { false })
        val ready = store.install(updated.first, updated.second)
        assertEquals(updated.second.snapshot, ready.snapshot)
        assertEquals(updated.second.snapshot, store.search("図書館").snapshot)
        assertTrue(orphan.exists())
        assertEquals(CleanupState.Deferred, store.cleanupState)
        val reopened = SQLiteDirectory(root, forms)
        assertEquals(updated.second.snapshot, reopened.current()!!.snapshot)
        reopened.retryCleanup()
        assertEquals(CleanupState.Complete, reopened.cleanupState)
        assertTrue(!orphan.exists())
    }

    @Test
    fun uncertainWriteUsesTheObservedPointerInsteadOfDeletingACommittedGeneration() {
        val root = File(context.cacheDir, "uncertain-${System.nanoTime()}").apply { mkdirs() }
        val baseline = archive(root, "baseline")
        val updated = archive(root, "updated")
        val forms = SearchForms.load()
        SQLiteDirectory(root, forms).install(baseline.first, baseline.second)
        val before =
            SQLiteDirectory(
                root,
                forms,
                writePointer = { _, _ -> throw java.io.IOException("before commit") },
            )
        assertThrows(java.io.IOException::class.java) {
            before.install(updated.first, updated.second)
        }
        assertEquals(baseline.second.snapshot, before.current()!!.snapshot)
        val after =
            SQLiteDirectory(
                root,
                forms,
                writePointer = { file, bytes ->
                    file.replace(bytes)
                    throw java.io.IOException("after commit")
                },
            )
        assertEquals(updated.second.snapshot, after.install(updated.first, updated.second).snapshot)
        assertEquals(updated.second.snapshot, after.current()!!.snapshot)
        assertEquals(ActivationOutcome.Recovered, after.activationOutcome)
    }

    @Test
    fun invalidImportPreservesSearchableGeneration() = runBlocking {
        val root = File(context.cacheDir, "publication-${System.nanoTime()}")
        val store = SQLiteDirectory(root, SearchForms.load())
        val listing = DatasetListing.parse(JSONObject(fixture("baseline", false).getString("body")))
        val file =
            File(root, "baseline.br").apply {
                parentFile!!.mkdirs()
                writeBytes(Base64.getDecoder().decode(fixture("baseline", true).getString("body")))
            }
        val saved = store.install(file, listing.archive)
        assertEquals(241L, saved.contacts)
        val archiveLines = store.activeArchive()!!.readLines()
        val header = ArchiveHeader(JSONObject(archiveLines[1]))
        val records =
            archiveLines.drop(2).mapIndexed { index, line -> header.record(line, index.toLong()) }
        for (query in
            listOf(
                "図書館",
                "公開",
                "Test",
                "facility",
                "Index",
                "library",
                "Test city 13",
                "03-0000-0000",
            )) {
            val text = SearchForms.load()
            val expected =
                if (CanonicalPhone.parse(query) != null)
                    records.filter { contact ->
                        contact.phones.any { it.number == CanonicalPhone.parse(query) }
                    }
                else
                    records.filter {
                        text.rank(
                            it.name,
                            listOf(it.prefecture, it.municipality, it.category.label),
                            query,
                        ) >= 0
                    }
            assertEquals(query, expected.size.toLong(), store.search(query).total)
        }
        val broken =
            File(root, "broken.br").apply { writeBytes(file.readBytes().dropLast(1).toByteArray()) }
        assertThrows(Exception::class.java) { store.install(broken, listing.archive) }
        assertEquals(saved.snapshot, store.current()!!.snapshot)
        assertEquals(saved.snapshot, SQLiteDirectory(root, SearchForms.load()).current()!!.snapshot)
    }

    @Test
    fun deltaAndArchiveProduceIdenticalSearchResults() = runBlocking {
        val root = File(context.cacheDir, "delta-${System.nanoTime()}").apply { mkdirs() }
        val baseline =
            DatasetListing.parse(JSONObject(fixture("baseline", false).getString("body")))
        val updated = DatasetListing.parse(JSONObject(fixture("updated", false).getString("body")))
        val store = SQLiteDirectory(root, SearchForms.load())
        fun archive(revision: String): File =
            File(root, "$revision.br").apply {
                writeBytes(Base64.getDecoder().decode(fixture(revision, true).getString("body")))
            }
        store.install(archive("baseline"), baseline.archive)
        val deltaFixture =
            (0 until fixtures.length())
                .map { fixtures.getJSONObject(it) }
                .first { "directory-delta-" in it.getString("path") }
        val deltaFile =
            File(root, "delta.br").apply {
                writeBytes(Base64.getDecoder().decode(deltaFixture.getString("body")))
            }
        val target =
            DirectoryDelta.rebuild(
                store.activeArchive()!!,
                deltaFile,
                File(root, "rebuilt.tsv"),
                updated.archive,
            )
        store.install(target)
        val afterDelta = store.search("図書館").contacts.map { it.name }
        val other = SQLiteDirectory(File(root, "full"), SearchForms.load())
        other.install(archive("updated"), updated.archive)
        assertEquals(other.search("図書館").contacts.map { it.name }, afterDelta)
        assertEquals(updated.archive.snapshot, store.current()!!.snapshot)
    }

    @Test
    fun unsafeMetadataAndUnknownFormatsAreRejected() {
        assertEquals(
            "https://example.org/directory (公開施設)",
            publicUrl("https://example.org/directory (公開施設)"),
        )
        assertEquals(
            "https://public_directory.example/",
            publicUrl("https://public_directory.example/"),
        )
        assertEquals("https://.partner.or.jp/", publicUrl("https://.partner.or.jp/"))
        assertThrows(Exception::class.java) { publicUrl("https://user:password@example.org/") }
        assertThrows(Exception::class.java) { publicUrl("javascript:alert(1)") }
        val original = JSONObject(fixture("baseline", false).getString("body"))
        original.getJSONArray("files").getJSONObject(3).put("url", "https://other.example/track")
        assertThrows(Exception::class.java) { DatasetListing.parse(original) }
        original.getJSONArray("files").getJSONObject(3).put("format", "unknown")
        assertThrows(Exception::class.java) { DatasetListing.parse(original) }
        assertNull(CanonicalPhone.parse("+8190x12345678"))
    }

    @Test
    fun completedReadersSurviveInterruptedAndConcurrentPublication() {
        val root = File(context.cacheDir, "concurrent-${System.nanoTime()}").apply { mkdirs() }
        fun archive(revision: String): Pair<File, ArchiveEntry> {
            val entry =
                DatasetListing.parse(JSONObject(fixture(revision, false).getString("body"))).archive
            return File(root, "$revision.br").apply {
                writeBytes(Base64.getDecoder().decode(fixture(revision, true).getString("body")))
            } to entry
        }
        val baseline = archive("baseline")
        val updated = archive("updated")
        val forms = SearchForms.load()
        val saved = SQLiteDirectory(root, forms).install(baseline.first, baseline.second)
        val interrupted = SQLiteDirectory(root, forms) { throw java.io.InterruptedIOException() }
        assertThrows(java.io.InterruptedIOException::class.java) {
            interrupted.install(updated.first, updated.second)
        }
        assertEquals(saved.snapshot, SQLiteDirectory(root, forms).current()!!.snapshot)
        assertTrue(File(root, "generations").listFiles()!!.none { it.name.startsWith("pending-") })
        val indexed = CountDownLatch(1)
        val activate = CountDownLatch(1)
        val executor = Executors.newSingleThreadExecutor()
        try {
            val store =
                SQLiteDirectory(root, forms) {
                    indexed.countDown()
                    if (!activate.await(10, TimeUnit.SECONDS))
                        throw java.util.concurrent.TimeoutException(
                            "Publication activation guard expired",
                        )
                }
            val future =
                executor.submit<page.dial.core.SyncState.Ready> {
                    store.install(updated.first, updated.second)
                }
            assertTrue(
                "Inconclusive: indexing guard expired",
                indexed.await(10, TimeUnit.SECONDS),
            )
            assertEquals(saved.snapshot, store.search("図書館").snapshot)
            assertEquals(saved.snapshot, SQLiteDirectory(root, forms).current()!!.snapshot)
            activate.countDown()
            assertEquals(updated.second.snapshot, future.get(10, TimeUnit.SECONDS).snapshot)
            assertEquals(updated.second.snapshot, store.search("図書館").snapshot)
        } finally {
            activate.countDown()
            executor.shutdownNow()
        }
    }

    @Test
    fun validDigestCannotAdmitInvalidRowsOrMissingFinalNewline() {
        val root = File(context.cacheDir, "rows-${System.nanoTime()}").apply { mkdirs() }
        val entry =
            DatasetListing.parse(JSONObject(fixture("baseline", false).getString("body"))).archive
        val file =
            File(root, "base.br").apply {
                writeBytes(Base64.getDecoder().decode(fixture("baseline", true).getString("body")))
            }
        val store = SQLiteDirectory(root, SearchForms.load())
        store.install(file, entry)
        val original = store.activeArchive()!!.readText()
        val otherSnapshot = digest("a".repeat(64))
        val candidate = entry.copy(snapshot = otherSnapshot)
        val replacement = original.replace(entry.snapshot.value, otherSnapshot.value)
        val headerLine = replacement.lineSequence().drop(1).first()
        val malformed =
            listOf(
                replacement.replaceFirst(headerLine, "$headerLine trailing"),
                replacement.dropLast(1),
                replacement.replaceFirst("\n0\t", "\n999999\t"),
                replacement.replaceFirst("\n0\t", "\n0.5\t"),
            )
        for ((index, text) in malformed.withIndex()) {
            val broken = File(root, "malformed-$index.tsv").apply { writeText(text) }
            assertThrows(java.io.IOException::class.java) {
                store.install(
                    RebuiltArchive(broken, candidate, broken.length(), FileDigest.sha256(broken)),
                )
            }
            assertEquals(entry.snapshot, store.current()!!.snapshot)
        }
    }
}
