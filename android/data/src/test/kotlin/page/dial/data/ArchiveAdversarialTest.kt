package page.dial.data

import java.io.IOException
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class ArchiveAdversarialTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun malformedRecordsCannotReplaceTheSavedSearchableGeneration() {
        val root = temporary.root
        val fixtures = ContractFixtures(root)
        val (archive, entry) = fixtures.archive("baseline")
        val store = SQLiteDirectory(root, SearchForms.load())
        val saved = store.install(archive, entry)
        val original = requireNotNull(store.activeArchive()).readText()
        val oldPointer = java.io.File(root, "active").readBytes()
        val candidate = entry.copy(snapshot = digest("a".repeat(64)))
        val lines =
            original.replace(entry.snapshot.value, candidate.snapshot.value).trimEnd('\n').lines()
        val record = lines[2].split('\t')
        val invalid =
            listOf(
                ArchiveColumn.Category to "999999",
                ArchiveColumn.Category to "0.5",
                ArchiveColumn.Category to "00",
                ArchiveColumn.Region to "99",
                ArchiveColumn.Name to "",
                ArchiveColumn.Name to "bad\u001fname",
                ArchiveColumn.Name to "bad\u001ename",
                ArchiveColumn.Address to "bad\u001faddress",
                ArchiveColumn.Phones to "110",
                ArchiveColumn.Phones to "0312345678\u001f0312345678",
                ArchiveColumn.Phones to "0312345678\u001e",
                ArchiveColumn.Website to "https://user:secret@example.test/",
                ArchiveColumn.Website to "javascript:alert(1)",
                ArchiveColumn.Provenance to "999999",
                ArchiveColumn.Origin to "999999",
                ArchiveColumn.Confirmation to "999999",
            )
        for ((column, value) in invalid) {
            val fields = record.toMutableList().apply { this[column.ordinal] = value }
            val text =
                (lines.take(2) + fields.joinToString("\t") + lines.drop(3)).joinToString(
                    "\n",
                    postfix = "\n",
                )
            val file = temporary.newFile().apply { writeText(text) }
            assertThrows("$column: $value", IOException::class.java) {
                store.install(
                    RebuiltArchive(file, candidate, file.length(), FileDigest.sha256(file))
                )
            }
            assertEquals(saved.snapshot, store.search("図書館").snapshot)
            assertTrue(java.io.File(root, "active").readBytes().contentEquals(oldPointer))
        }
        assertEquals(original, requireNotNull(store.activeArchive()).readText())
    }

    @Test
    fun headersRejectDuplicateDictionariesCountsAndUnsafeUrls() {
        val fixtures = ContractFixtures(temporary.root)
        val text = fixtures.decoded("baseline").lines()[1]
        val invalid: List<(JSONObject) -> Unit> =
            listOf(
                { it.put("contacts", -1) },
                { it.put("contacts", "241") },
                { it.put("contacts", 241.5) },
                { it.put("snapshot", "A".repeat(64)) },
                {
                    it.getJSONArray("categories")
                        .put(it.getJSONArray("categories").getJSONObject(0))
                },
                { it.getJSONArray("categories").getJSONObject(0).put("label", "") },
                {
                    it.getJSONArray("categories")
                        .getJSONObject(0)
                        .put("licenseUrl", "file:///tmp/license")
                },
                { it.getJSONArray("prefectures").getJSONObject(0).put("code", "00") },
                { it.getJSONArray("prefectures").getJSONObject(0).put("contacts", 999) },
                { it.getJSONArray("provenances").getJSONObject(0).put("source", 999) },
                {
                    it.getJSONArray("sources")
                        .getJSONObject(0)
                        .put("url", "https://user:secret@example.test/")
                },
                { it.getJSONArray("links").put(0, "javascript:alert(1)") },
            )
        for (change in invalid) {
            val header = parseObject(text).apply(change)
            assertThrows(IOException::class.java) { ArchiveHeader(header) }
        }
    }

    @Test
    fun linesEnforceExactByteLimitsNewlinesAndUtf8AcrossBufferBoundaries() {
        val invalid =
            listOf(
                "missing newline".toByteArray(),
                byteArrayOf(0, 10),
                byteArrayOf(13, 10),
                byteArrayOf(-64, -81, 10),
            )
        for (bytes in invalid) assertThrows(IOException::class.java) {
            Lines(bytes.inputStream()).use { it.next() }
        }
        Lines("abc\n".byteInputStream()).use {
            assertEquals("abc", it.next(3))
            assertEquals(4L, it.consumed)
            assertEquals(null, it.next())
        }
        assertThrows(IOException::class.java) {
            Lines("abcd\n".byteInputStream()).use { it.next(3) }
        }
        val large = "a".repeat(page.dial.core.DirectoryLimits.BUFFER_BYTES - 1) + "📞"
        Lines("$large\nsecond\n".byteInputStream()).use {
            assertEquals(large, it.next())
            assertEquals("second", it.next())
            assertEquals(null, it.next())
        }
    }
}
