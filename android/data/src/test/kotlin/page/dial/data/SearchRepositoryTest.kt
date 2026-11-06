package page.dial.data

import android.os.CancellationSignal
import android.os.OperationCanceledException
import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import page.dial.core.CanonicalPhone
import page.dial.core.Contact
import page.dial.core.DirectoryLimits

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class SearchRepositoryTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun sqlSearchRankingCategoryAndPaginationMatchTheFullScanOracle() {
        val fixtures = ContractFixtures(temporary.root)
        val (archive, entry) = fixtures.archive("baseline")
        val forms = SearchForms.load()
        val store = SQLiteDirectory(temporary.root, forms)
        store.install(archive, entry)
        val lines = requireNotNull(store.activeArchive()).readLines()
        val header = ArchiveHeader(parseObject(lines[1]))
        val records =
            lines.drop(2).mapIndexed { index, line -> header.record(line, index.toLong()) }
        val random = Random(0x53514c)
        val sampled =
            List(32) {
                val record = records[random.nextInt(records.size)]
                forms.words(record.name).first()
            }
        val queries =
            sampled +
                listOf(
                    "Index",
                    "facility",
                    "図書館",
                    "Test city 13",
                    "\" OR 1=1 --",
                    "a' UNION SELECT",
                    "0*",
                    "０３－００００－００００",
                )
        for (query in queries) for (category in
            listOf(null, records.first().category.id, "' OR 1=1 --")) {
            val phone = CanonicalPhone.parse(query)
            fun rank(record: Contact) =
                forms.rank(
                    record.name,
                    listOf(record.prefecture, record.municipality, record.category.label),
                    query,
                )
            val expected =
                records
                    .filter {
                        (category == null || it.category.id == category) &&
                            if (phone != null) it.phones.any { value -> value.number == phone }
                            else rank(it) >= 0
                    }
                    .sortedWith { left, right ->
                        val ranked = if (phone == null) rank(left).compareTo(rank(right)) else 0
                        val name =
                            compareBytes(
                                forms.form(left.name).toByteArray(),
                                forms.form(right.name).toByteArray(),
                            )
                        if (ranked != 0) ranked
                        else if (name != 0) name else left.row.compareTo(right.row)
                    }
            val actual = buildList {
                for (offset in 0..expected.size step DirectoryLimits.SEARCH_PAGE_SIZE) {
                    val page = store.search(query, category, offset)
                    assertEquals("$query / $category", expected.size.toLong(), page.total)
                    assertEquals(entry.snapshot, page.snapshot)
                    addAll(page.contacts)
                }
            }
            assertEquals("$query / $category", expected, actual)
        }
    }

    @Test
    fun invalidSearchesAndCancelledCallerLookupsDoNotReadUnboundedData() {
        val fixtures = ContractFixtures(temporary.root)
        val (file, entry) = fixtures.archive("baseline")
        val store = SQLiteDirectory(temporary.root, SearchForms.load())
        store.install(file, entry)
        for (query in
            listOf(
                "",
                " ",
                List(9) { "word" }.joinToString(" "),
                "a".repeat(DirectoryLimits.MAXIMUM_QUERY_BYTES + 1),
            )) {
            assertEquals(0L, store.search(query).total)
        }
        assertTrue(store.search("Index", offset = -1).contacts.isEmpty())
        assertTrue(
            store.search("Index", offset = DirectoryLimits.MAXIMUM_CONTACTS + 1).contacts.isEmpty()
        )
        val phone = requireNotNull(CanonicalPhone.parse("03-0000-0000"))
        assertNotNull(store.find(phone))
        val cancellation = CancellationSignal().apply { cancel() }
        assertThrows(OperationCanceledException::class.java) { store.find(phone, cancellation) }
    }
}
