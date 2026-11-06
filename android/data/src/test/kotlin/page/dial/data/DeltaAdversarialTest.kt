package page.dial.data

import java.io.File
import java.io.IOException
import org.brotli.dec.BrotliInputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class DeltaAdversarialTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun malformedDeltaInstructionsAndMetadataNeverReplaceTheSavedGeneration() {
        val fixtures = ContractFixtures(temporary.root)
        val (file, entry) = fixtures.archive("baseline")
        val target = fixtures.listing("updated").archive
        val store = SQLiteDirectory(temporary.root, SearchForms.load())
        store.install(file, entry)
        val base = requireNotNull(store.activeArchive())
        val saved = base.readBytes()
        val delta =
            BrotliInputStream(fixtures.delta().inputStream()).bufferedReader().use { it.readText() }
        val lines = delta.trimEnd('\n').lines()
        val invalid =
            listOf(
                "invalid\n" + lines.drop(1).joinToString("\n", postfix = "\n"),
                delta.dropLast(1),
                (lines.take(3) + "^\t0\t1").joinToString("\n", postfix = "\n"),
                (lines.take(3) + "=\t0\t0").joinToString("\n", postfix = "\n"),
                (lines.take(3) + "=\t-1\t1").joinToString("\n", postfix = "\n"),
                (lines.take(3) + "=\t99999999\t1").joinToString("\n", postfix = "\n"),
                (lines.take(3) + "=\t0\t99999999").joinToString("\n", postfix = "\n"),
                (lines.take(3) + listOf("=\t0\t1", "=\t0\t1")).joinToString("\n", postfix = "\n"),
                lines.dropLast(1).joinToString("\n", postfix = "\n"),
                (lines.take(3) + "+\tinvalid").joinToString("\n", postfix = "\n"),
            )
        for (text in invalid) {
            assertThrows(IOException::class.java) {
                DirectoryDelta.rebuildDecoded(
                    base,
                    text.byteInputStream(),
                    temporary.newFile(),
                    target,
                )
            }
            assertEquals(entry.snapshot, store.current()!!.snapshot)
            assertArrayEquals(saved, base.readBytes())
        }
        val wrong = target.copy(sha256 = digest("a".repeat(64)))
        assertThrows(IOException::class.java) {
            DirectoryDelta.rebuildDecoded(base, delta.byteInputStream(), temporary.newFile(), wrong)
        }
    }

    @Test
    fun compressedAndDecodedPathsMatchAndRequireTheDeclaredDecodedIdentity() {
        val fixtures = ContractFixtures(temporary.root)
        val (file, entry) = fixtures.archive("baseline")
        val store = SQLiteDirectory(temporary.root, SearchForms.load())
        store.install(file, entry)
        val base = requireNotNull(store.activeArchive())
        val delta = fixtures.delta()
        val decoded =
            temporary.newFile().apply {
                BrotliInputStream(delta.inputStream()).use { input ->
                    outputStream().use { output -> input.copyTo(output) }
                }
            }
        val identity = DecodedIdentity(decoded.length(), FileDigest.sha256(decoded))
        val target = fixtures.listing("updated").archive
        val compressed =
            DirectoryDelta.rebuild(
                base,
                delta,
                File(temporary.root, "compressed.tsv"),
                target,
                identity,
            )
        val plain =
            DirectoryDelta.rebuildDecoded(
                base,
                decoded.inputStream(),
                File(temporary.root, "decoded.tsv"),
                target,
                identity,
            )
        assertArrayEquals(compressed.file.readBytes(), plain.file.readBytes())
        for (bad in
            listOf(
                identity.copy(bytes = identity.bytes + 1),
                identity.copy(sha256 = digest("a".repeat(64))),
            )) {
            assertThrows(IOException::class.java) {
                DirectoryDelta.rebuild(base, delta, temporary.newFile(), target, bad)
            }
        }
    }
}
