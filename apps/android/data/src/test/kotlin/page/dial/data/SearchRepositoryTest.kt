package page.dial.data

import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteException
import android.os.CancellationSignal
import android.os.OperationCanceledException
import java.io.File
import kotlin.random.Random
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
    fun readingsFindPlacesWithoutRebuildingTheSavedFullTextIndex() {
        val store =
            namedDirectory(
                listOf("中央館" to 0, "としょかん分室" to 1, "分室" to 1),
                kinds = listOf("library", "medical"),
                region = "13",
            )
        val archive = requireNotNull(store.activeArchive())
        val before = FileDigest.sha256(archive)
        val database = File(archive.parentFile, "directory.db")
        val savedIndex = FileDigest.sha256(database)
        val matches = store.preview("としょかん")
        assertEquals(2L, matches.total)
        assertEquals(
            listOf("としょかん分室", "中央館"),
            matches.groups.flatMap { it.contacts }.map { it.name },
        )
        assertEquals(2L, store.preview("とうきょう としょかん").total)
        assertEquals(2L, store.preview(List(8) { "としょかん" }.joinToString(" ")).total)
        assertEquals(3L, store.preview("とうきょう").total)
        assertEquals(1L, store.preview("と").total)
        assertEquals(0L, store.preview("としょこ").total)
        assertEquals(3L, store.search("03-0000-0000").total)
        assertEquals(before, FileDigest.sha256(archive))
        assertEquals(savedIndex, FileDigest.sha256(database))
    }

    @Test
    fun equalRanksFollowNormalizedNamesInsteadOfKanaFoldedNames() {
        val store = namedDirectory(listOf("あ施設" to 0, "が施設" to 0, "ア施設" to 0))
        assertEquals(listOf("あ施設", "が施設", "ア施設"), store.search("施設").contacts.map { it.name })
    }

    @Test
    fun previewsIncludeEveryMatchingCategoryAndItsFullCount() {
        val store =
            namedDirectory(
                List(80) { "A facility ${it.toString().padStart(2, '0')}" to 0 } +
                    List(4) { "Z facility $it" to 1 } +
                    listOf("M facility" to 2),
            )
        val results = store.preview("facility")
        assertEquals(85L, results.total)
        assertEquals(listOf(80L, 1L, 4L), results.groups.map { it.total })
        assertEquals(listOf(3, 1, 3), results.groups.map { it.contacts.size })
        assertEquals(
            listOf("A facility 00", "M facility", "Z facility 0"),
            results.groups.map { it.contacts.first().name },
        )
        val last = results.groups.last()
        assertEquals(4L, store.search("facility", last.category.id).total)
        assertEquals(4, store.search("facility", last.category.id).contacts.size)
    }

    @Test
    fun everyAdmittedCategoryFitsTheBoundedPreviewPayloadQuery() {
        val store =
            namedDirectory(
                (0 until DirectoryLimits.MAXIMUM_CATEGORY_COUNT).flatMap { category ->
                    List(4) { "facility ${category.toString().padStart(3, '0')} $it" to category }
                },
            )
        val preview = store.preview("facility")
        assertEquals(DirectoryLimits.MAXIMUM_CATEGORY_COUNT, preview.groups.size)
        assertEquals(DirectoryLimits.MAXIMUM_CATEGORY_COUNT * 4L, preview.total)
        assertEquals(
            DirectoryLimits.MAXIMUM_CATEGORY_COUNT * 3,
            preview.groups.sumOf { it.contacts.size },
        )
        assertTrue(preview.groups.all { it.total == 4L && it.contacts.size == 3 })
    }

    @Test
    fun aFailedSavedDatabaseMigrationRollsBackAndCanRetryWithoutChangingTheDirectory() {
        val store = namedDirectory(listOf("あ施設" to 0, "が施設" to 0, "ア施設" to 0))
        val archive = requireNotNull(store.activeArchive())
        val archiveHash = FileDigest.sha256(archive)
        val ready = store.current()
        val phone = requireNotNull(CanonicalPhone.parse("03-0000-0000"))
        val caller = store.find(phone)
        SQLiteDatabase.openDatabase(
                File(archive.parentFile, "directory.db").path,
                null,
                SQLiteDatabase.OPEN_READWRITE,
            )
            .use { db ->
                db.execSQL("ALTER TABLE contacts RENAME TO ordered_contacts")
                db.execSQL(
                    "CREATE TABLE contacts(id INTEGER PRIMARY KEY,raw TEXT NOT NULL," +
                        "name TEXT NOT NULL,place TEXT NOT NULL,category TEXT NOT NULL)",
                )
                db.execSQL(
                    "INSERT INTO contacts SELECT id,raw,name,place,category FROM ordered_contacts",
                )
                db.execSQL("DROP TABLE ordered_contacts")
                db.version = 0
                db.execSQL(
                    "CREATE TRIGGER reject_sort BEFORE UPDATE ON contacts WHEN NEW.id=1 " +
                        "BEGIN SELECT RAISE(FAIL,'interrupted migration'); END",
                )
                assertThrows(SQLiteException::class.java) { SearchOrder.migrate(db) }
                assertEquals(0, db.version)
                val columns =
                    db.rawQuery("PRAGMA table_info(contacts)", null).use { rows ->
                        buildList { while (rows.moveToNext()) add(rows.getString(1)) }
                    }
                assertFalse("sort_name" in columns)
                db.execSQL("DROP TRIGGER reject_sort")
            }
        assertEquals(listOf("あ施設", "が施設", "ア施設"), store.search("施設").contacts.map { it.name })
        assertEquals(ready, store.current())
        assertEquals(caller, store.find(phone))
        assertEquals(archiveHash, FileDigest.sha256(archive))
        store.prepareSearch()
        assertEquals(3L, store.preview("施設").total)
    }

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
            val expected = expected(records, query, category, forms)
            val actual = buildList {
                for (offset in 0..expected.size step DirectoryLimits.SEARCH_PAGE_SIZE) {
                    val page = store.search(query, category, offset)
                    assertEquals("$query / $category", expected.size.toLong(), page.total)
                    assertEquals(entry.snapshot, page.snapshot)
                    addAll(page.contacts)
                }
            }
            assertEquals("$query / $category", expected, actual)
            if (category == null) {
                val preview = store.preview(query)
                val groups = expected.groupBy { it.category }
                assertEquals(expected.size.toLong(), preview.total)
                assertEquals(groups.keys.toList(), preview.groups.map { it.category })
                assertEquals(
                    groups.values.map { it.size.toLong() },
                    preview.groups.map { it.total },
                )
                assertEquals(groups.values.map { it.take(3) }, preview.groups.map { it.contacts })
            }
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
            assertTrue(store.preview(query).groups.isEmpty())
        }
        assertTrue(store.search("Index", offset = -1).contacts.isEmpty())
        assertTrue(
            store.search("Index", offset = DirectoryLimits.MAXIMUM_CONTACTS + 1).contacts.isEmpty(),
        )
        val phone = requireNotNull(CanonicalPhone.parse("03-0000-0000"))
        assertNotNull(store.find(phone))
        val cancellation = CancellationSignal().apply { cancel() }
        assertThrows(OperationCanceledException::class.java) { store.find(phone, cancellation) }
        assertThrows(OperationCanceledException::class.java) {
            store.preview("Index", cancellation)
        }
        assertThrows(OperationCanceledException::class.java) {
            store.search("Index", cancellation = cancellation)
        }
    }

    private fun expected(
        records: List<Contact>,
        query: String,
        category: String?,
        forms: page.dial.core.SearchText,
    ): List<Contact> {
        val phone = CanonicalPhone.parse(query)
        fun rank(record: Contact) =
            forms.rank(
                record.name,
                listOf(record.prefecture, record.municipality, record.category.label),
                query,
            )
        return records
            .filter {
                (category == null || it.category.id == category) &&
                    if (phone != null) it.phones.any { value -> value.number == phone }
                    else rank(it) >= 0
            }
            .sortedWith { left, right ->
                val ranked = if (phone == null) rank(left).compareTo(rank(right)) else 0
                val name =
                    compareBytes(
                        SearchOrder.key(left.name).toByteArray(),
                        SearchOrder.key(right.name).toByteArray(),
                    )
                if (ranked != 0) ranked else if (name != 0) name else left.row.compareTo(right.row)
            }
    }

    private fun namedDirectory(
        names: List<Pair<String, Int>>,
        kinds: List<String> = emptyList(),
        region: String? = null,
    ): SQLiteDirectory {
        val fixtures = ContractFixtures(temporary.root)
        val lines = fixtures.decoded("baseline").lines()
        val header = JSONObject(lines[1])
        val original = header.getJSONArray("categories")
        val selected = kinds.map { id -> original.objects().single { it.getString("id") == id } }
        val categories = if (kinds.isEmpty()) original else org.json.JSONArray(selected)
        header.put("categories", categories)
        val lastCategory = names.maxOf { it.second }
        while (categories.length() <= lastCategory) {
            val index = categories.length()
            categories.put(
                JSONObject(categories.getJSONObject(0).toString())
                    .put("id", "category-$index")
                    .put("label", "Category $index"),
            )
        }
        val template = lines[2].split('\t').toMutableList()
        if (region != null) template[ArchiveColumn.Region.ordinal] = region
        val rows =
            names
                .map { (name, category) ->
                    template
                        .toMutableList()
                        .apply {
                            this[ArchiveColumn.Name.ordinal] = name
                            this[ArchiveColumn.Category.ordinal] = category.toString()
                        }
                        .joinToString("\t")
                }
                .sortedWith { left, right -> compareBytes(left.toByteArray(), right.toByteArray()) }
        header.put("contacts", rows.size)
        header.getJSONArray("prefectures").objects().forEach {
            it.put("contacts", if (it.getString("code") == template[1].take(2)) rows.size else 0)
        }
        val root = temporary.newFolder()
        val file =
            File(root, "custom.tsv").apply {
                writeText(
                    (listOf(ARCHIVE_SIGNATURE, header.toString()) + rows).joinToString(
                        "\n",
                        postfix = "\n",
                    ),
                )
            }
        val hash = FileDigest.sha256(file)
        val entry =
            ArchiveEntry(
                digest(header.getString("snapshot")),
                rows.size.toLong(),
                file.length(),
                hash,
                "",
            )
        return SQLiteDirectory(root, SearchForms.load()).also {
            it.install(RebuiltArchive(file, entry, file.length(), hash))
        }
    }
}
