package page.dial.data

import android.util.AtomicFile
import java.io.File
import java.io.IOException
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
class PointerRecoveryTest {
    @get:Rule val temporary = TemporaryFolder()
    private val first = "a".repeat(64) + "-" + "b".repeat(64)
    private val second = "c".repeat(64) + "-" + "d".repeat(64)

    @Test
    fun pointerRoundTripsAndInterruptedWritesRestoreThePreviousRecord() {
        val pointer = AtomicFile(File(temporary.root, "active"))
        assertEquals(null, GenerationPointer.read(pointer))
        pointer.replace(first.toByteArray())
        assertEquals(GenerationPointer(first, null), GenerationPointer.read(pointer))
        pointer.replace(GenerationPointer(second, first).bytes())
        val interrupted = pointer.startWrite()
        interrupted.write("{\"format\":".toByteArray())
        pointer.failWrite(interrupted)
        assertEquals(GenerationPointer(second, first), GenerationPointer.read(pointer))
    }

    @Test
    fun malformedPointersCannotNameFilesOutsideTheGenerationDirectory() {
        val pointer = AtomicFile(File(temporary.root, "active"))
        for (text in
            listOf(
                "../outside",
                "{\"format\":2,\"current\":\"$first\",\"previous\":null}",
                "{\"format\":1,\"current\":\"../outside\",\"previous\":null}",
                "{\"format\":1,\"current\":\"$first\",\"previous\":\"../outside\"}",
            )) {
            pointer.replace(text.toByteArray())
            assertThrows(IOException::class.java) { GenerationPointer.read(pointer) }
        }
    }

    @Test
    fun cleanupProtectsBothTheCurrentAndPreviousCompleteGeneration() {
        val fixtures = ContractFixtures(temporary.root)
        val forms = SearchForms.load()
        val store = SQLiteDirectory(temporary.root, forms)
        val (baseline, base) = fixtures.archive("baseline")
        val (updated, target) = fixtures.archive("updated")
        store.install(baseline, base)
        val original = requireNotNull(store.activeArchive())
        val savedBytes = original.readBytes()
        store.install(updated, target)
        store.retryCleanup()
        val pointer =
            requireNotNull(GenerationPointer.read(AtomicFile(File(temporary.root, "active"))))
        assertEquals(original.parentFile!!.name, pointer.previous)
        assertTrue(original.exists())
        assertTrue(savedBytes.contentEquals(original.readBytes()))
        assertEquals(target.snapshot, SQLiteDirectory(temporary.root, forms).current()!!.snapshot)
    }
}
