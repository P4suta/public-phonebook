package page.dial.publicphonebook

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import page.dial.core.CanonicalPhone
import page.dial.core.Category
import page.dial.core.Contact
import page.dial.core.DirectoryRepository
import page.dial.core.SearchGroup
import page.dial.core.SearchPage
import page.dial.core.SearchResults
import page.dial.core.SnapshotId
import page.dial.core.SyncState

@OptIn(ExperimentalCoroutinesApi::class)
class DirectoryViewModelTest {
    private val models = ViewModelStore()

    @Before
    fun mainDispatcher() {
        Dispatchers.setMain(StandardTestDispatcher())
    }

    @After
    fun releaseModels() {
        models.clear()
        Dispatchers.resetMain()
    }

    @Test
    fun composingDraftsWaitForAnUnchangedTextCommitBeforeSearching() = runTest {
        val repository = Pages(results(page()))
        val model = model(repository)
        advanceUntilIdle()
        repository.previews.clear()
        model.search("国", composing = true)
        advanceUntilIdle()
        assertTrue(repository.previews.isEmpty())
        model.search("国立", composing = true)
        model.more("library")
        model.refresh()
        advanceUntilIdle()
        assertEquals("国立", model.uiState.value.query)
        assertTrue(model.uiState.value.composing)
        assertFalse(model.uiState.value.searching)
        assertTrue(repository.previews.isEmpty())
        assertTrue(repository.searches.isEmpty())
        model.search("国立")
        advanceUntilIdle()
        assertEquals(listOf("国立"), repository.previews)
        assertEquals("国立", model.uiState.value.resultQuery)
        assertFalse(model.uiState.value.composing)
    }

    @Test
    fun preparationDoesNotCommitAnActiveComposition() = runTest {
        val waiting = CompletableDeferred<Unit>()
        val repository = Pages(results(page()))
        repository.beforePrepare = { waiting.await() }
        val model = model(repository)
        runCurrent()
        model.search("国立", composing = true)
        advanceUntilIdle()
        waiting.complete(Unit)
        advanceUntilIdle()
        assertTrue(model.uiState.value.composing)
        assertTrue(repository.previews.isEmpty())
        model.search("国立")
        advanceUntilIdle()
        assertEquals(listOf("国立"), repository.previews)
    }

    @Test
    fun aLatePreviewCannotPublishDuringComposition() = runTest {
        val repository = Pages(results(page()))
        val model = model(repository)
        advanceUntilIdle()
        val waiting = CompletableDeferred<Unit>()
        repository.beforePreview = { withContext(NonCancellable) { waiting.await() } }
        model.search("国立")
        advanceTimeBy(180)
        runCurrent()
        model.search("国立", composing = true)
        waiting.complete(Unit)
        advanceUntilIdle()
        assertTrue(model.uiState.value.composing)
        assertFalse(model.uiState.value.searching)
        assertEquals("", model.uiState.value.resultQuery)
        model.search("国立")
        advanceUntilIdle()
        assertEquals("国立", model.uiState.value.resultQuery)
    }

    @Test
    fun eachCategoryExpandsFromItsPreviewAndContinuesIndependently() = runTest {
        val repository =
            Pages(
                results(page(), page(category = "medical", rows = 100L..102L)),
                page(rows = 0L..29L),
                page(rows = 30L..34L),
            )
        val model = model(repository)
        advanceUntilIdle()
        model.more("library")
        advanceUntilIdle()
        assertEquals((0L..29L).toList(), rows(model))
        assertEquals((100L..102L).toList(), rows(model, "medical"))
        model.more("library")
        advanceUntilIdle()
        assertEquals(listOf("library" to 0, "library" to 30), repository.searches)
        assertEquals((0L..34L).toList(), rows(model))
        assertEquals(
            listOf("library", "medical"),
            model.uiState.value.results.groups.map { it.category.id },
        )
        model.more("library")
        model.more("missing")
        assertEquals(2, repository.searches.size)
    }

    @Test
    fun aNewGenerationRestartsEveryCategoryBeforeAppendingAnything() = runTest {
        val updated = results(page("b", rows = 8L..10L), page("b", "medical", 100L..102L))
        val repository = Pages(results(page()), page("b", rows = 0L..29L))
        repository.beforeSearch = { repository.previewResponse = updated }
        val model = model(repository)
        advanceUntilIdle()
        model.more("library")
        advanceUntilIdle()
        assertEquals(updated, model.uiState.value.results)
        assertEquals(2, repository.previews.size)
        assertTrue(model.uiState.value.expandedCategories.isEmpty())
        assertTrue(model.uiState.value.loadingCategories.isEmpty())
    }

    @Test
    fun differentCategoriesCanFinishInEitherOrderWithoutLosingResults() = runTest {
        val waiting =
            mapOf(
                "library" to CompletableDeferred<Unit>(),
                "medical" to CompletableDeferred<Unit>(),
            )
        val repository =
            Pages(
                results(page(), page(category = "medical", rows = 100L..102L)),
                page(rows = 0L..29L),
                page(category = "medical", rows = 100L..129L),
            )
        repository.beforeSearch = { waiting.getValue(it).await() }
        val model = model(repository)
        advanceUntilIdle()
        model.more("library")
        model.more("medical")
        model.more("library")
        runCurrent()
        assertEquals(2, repository.searches.size)
        waiting.getValue("medical").complete(Unit)
        runCurrent()
        assertEquals(30, rows(model, "medical").size)
        assertEquals(setOf("library"), model.uiState.value.loadingCategories)
        waiting.getValue("library").complete(Unit)
        advanceUntilIdle()
        assertEquals(30, rows(model).size)
        assertEquals(30, rows(model, "medical").size)
        assertTrue(model.uiState.value.loadingCategories.isEmpty())
    }

    @Test
    fun aFailedCategoryKeepsItsPreviewAndCanRetryWithoutChangingOtherCategories() = runTest {
        val initial = results(page(), page(category = "medical", rows = 100L..102L))
        val repository = Pages(initial, page(rows = 0L..29L), page(rows = 0L..29L))
        repository.beforeSearch = { throw java.io.IOException("offline") }
        val model = model(repository)
        advanceUntilIdle()
        model.more("library")
        advanceUntilIdle()
        assertEquals(initial, model.uiState.value.results)
        assertEquals(setOf("library"), model.uiState.value.failedCategories)
        assertTrue(model.uiState.value.loadingCategories.isEmpty())
        repository.beforeSearch = {}
        model.more("library")
        advanceUntilIdle()
        assertTrue(model.uiState.value.failedCategories.isEmpty())
        assertEquals(30, rows(model).size)
        assertEquals((100L..102L).toList(), rows(model, "medical"))
        assertEquals(listOf("library" to 0, "library" to 0), repository.searches)
    }

    @Test
    fun aCategoryReplyCannotReplaceResultsAfterTheQueryChanges() = runTest {
        val waiting = CompletableDeferred<Unit>()
        val repository = Pages(results(page()), page(rows = 0L..29L))
        repository.beforeSearch = { withContext(NonCancellable) { waiting.await() } }
        val model = model(repository)
        advanceUntilIdle()
        model.more("library")
        runCurrent()
        val latest = results(page(rows = 9L..9L, total = 1))
        repository.previewResponse = latest
        model.search("latest")
        advanceUntilIdle()
        waiting.complete(Unit)
        advanceUntilIdle()
        assertEquals(latest, model.uiState.value.results)
        assertEquals("latest", model.uiState.value.resultQuery)
        assertTrue(model.uiState.value.loadingCategories.isEmpty())
        assertTrue(model.uiState.value.failedCategories.isEmpty())
    }

    @Test
    fun continuationWaitsForTheRequestedQueryPreview() = runTest {
        val repository = Pages(results(page()))
        val model = model(repository)
        advanceUntilIdle()
        model.search("requested")
        model.more("library")
        advanceUntilIdle()
        assertTrue(repository.searches.isEmpty())
        assertEquals("requested", model.uiState.value.resultQuery)
    }

    @Test
    fun replacingAnInFlightQueryCancelsOldWorkAndPreservesTheLatestSavedQuery() = runTest {
        val repository = Pages(results(page()))
        var cancelled = false
        repository.beforePreview = { query ->
            if (query == "slow")
                try {
                    awaitCancellation()
                } finally {
                    cancelled = true
                }
        }
        val saved = SavedStateHandle()
        val model = model(repository, saved)
        advanceUntilIdle()
        model.search("slow")
        advanceTimeBy(181)
        runCurrent()
        model.search("latest")
        advanceUntilIdle()
        assertTrue(cancelled)
        assertEquals("latest", saved.get<String>("query"))
        assertEquals("latest", model.uiState.value.resultQuery)
        assertFalse(model.uiState.value.searching)
        assertFalse(model.uiState.value.searchFailed)
    }

    @Test
    fun searchFailureRetainsSavedResultsAndASuccessfulRetryClearsTheFailure() = runTest {
        val initial = results(page())
        val repository = Pages(initial)
        repository.beforePreview = { if (it == "bad") throw java.io.IOException("offline") }
        val model = model(repository)
        advanceUntilIdle()
        model.search("bad")
        advanceUntilIdle()
        assertTrue(model.uiState.value.searchFailed)
        assertFalse(model.uiState.value.searching)
        assertEquals(initial, model.uiState.value.results)
        model.more("library")
        assertTrue(repository.searches.isEmpty())
        model.search("retry")
        advanceUntilIdle()
        assertFalse(model.uiState.value.searchFailed)
        assertEquals("retry", model.uiState.value.resultQuery)
    }

    @Test
    fun preparationCanRetryAfterAnInitialFailure() = runTest {
        val repository = Pages(results(page()))
        repository.prepareFailure = java.io.IOException("unavailable storage")
        val model = model(repository, SavedStateHandle(mapOf("query" to "restored")))
        advanceUntilIdle()
        assertEquals(SyncState.Failed(null), model.uiState.value.sync)
        repository.prepareFailure = null
        model.prepare()
        advanceUntilIdle()
        assertTrue(model.uiState.value.sync is SyncState.Ready)
        assertEquals("restored", model.uiState.value.resultQuery)
    }

    @Test
    fun refreshPreservesCompositionTypedDuringTheUpdate() = runTest {
        val repository = Pages(results(page()))
        val model = model(repository)
        advanceUntilIdle()
        repository.previews.clear()
        val waiting = CompletableDeferred<Unit>()
        repository.beforeRefresh = { waiting.await() }
        model.refresh()
        runCurrent()
        model.search("国立", composing = true)
        advanceUntilIdle()
        waiting.complete(Unit)
        advanceUntilIdle()
        assertEquals("国立", model.uiState.value.query)
        assertTrue(model.uiState.value.composing)
        assertFalse(model.uiState.value.updating)
        assertTrue(repository.previews.isEmpty())
        model.search("国立")
        advanceUntilIdle()
        assertEquals(listOf("国立"), repository.previews)
        assertEquals("国立", model.uiState.value.resultQuery)
    }

    @Test
    fun refreshPreservesCommittedInputTypedDuringTheUpdate() = runTest {
        val repository = Pages(results(page()))
        val model = model(repository)
        advanceUntilIdle()
        repository.previews.clear()
        val waiting = CompletableDeferred<Unit>()
        repository.beforeRefresh = { waiting.await() }
        model.refresh()
        runCurrent()
        model.search("国立")
        advanceUntilIdle()
        waiting.complete(Unit)
        advanceUntilIdle()
        assertEquals("国立", model.uiState.value.query)
        assertEquals("国立", model.uiState.value.resultQuery)
        assertFalse(model.uiState.value.composing)
        assertFalse(model.uiState.value.updating)
        assertEquals(listOf("国立", "国立"), repository.previews)
    }

    @Test
    fun overlappingRefreshesRunOnceAndFailureKeepsSearchAvailable() = runTest {
        val initial = results(page())
        val repository = Pages(initial)
        val waiting = CompletableDeferred<Unit>()
        repository.beforeRefresh = {
            waiting.await()
            throw java.io.IOException("offline")
        }
        val model = model(repository)
        advanceUntilIdle()
        model.refresh()
        model.refresh()
        runCurrent()
        assertEquals(1, repository.refreshes)
        assertTrue(model.uiState.value.updating)
        waiting.complete(Unit)
        advanceUntilIdle()
        assertFalse(model.uiState.value.updating)
        assertEquals(R.string.update_failed, model.uiState.value.updateMessage)
        assertEquals(initial, model.uiState.value.results)
        assertTrue(model.uiState.value.sync is SyncState.Ready)
    }

    private fun model(
        repository: Pages,
        saved: SavedStateHandle = SavedStateHandle(),
    ): DirectoryViewModel =
        DirectoryViewModel(repository, saved).also { models.put("directory", it) }

    private fun rows(model: DirectoryViewModel, category: String = "library"): List<Long> =
        model.uiState.value.results.groups
            .single { it.category.id == category }
            .contacts
            .map { it.row }

    private fun page(
        identity: String = "a",
        category: String = "library",
        rows: LongRange = 0L..2L,
        total: Long = 35,
    ): SearchPage {
        val snapshot = requireNotNull(SnapshotId.parse(identity.repeat(64)))
        return SearchPage(
            rows.map {
                Contact(
                    snapshot,
                    it,
                    Category(category, category),
                    "",
                    "",
                    "Facility $it",
                    "",
                    emptyList(),
                    null,
                    "https://example.test",
                    "Publisher",
                    "CC0",
                    "https://example.test/license",
                    "2026-11-05",
                )
            },
            total,
            snapshot,
        )
    }

    private fun results(vararg pages: SearchPage): SearchResults =
        SearchResults(
            pages.map { SearchGroup(it.contacts.first().category, it.contacts, it.total) },
            pages.first().snapshot,
        )
}

private class Pages(var previewResponse: SearchResults, vararg pages: SearchPage) :
    DirectoryRepository {
    private val responses = ArrayDeque(pages.toList())
    val searches = mutableListOf<Pair<String, Int>>()
    val previews = mutableListOf<String>()
    var beforePreview: suspend (String) -> Unit = {}
    var beforePrepare: suspend () -> Unit = {}
    var beforeSearch: suspend (String) -> Unit = {}
    var beforeRefresh: suspend () -> Unit = {}
    var prepareFailure: Exception? = null
    var refreshes = 0

    override suspend fun prepare(): SyncState.Ready {
        beforePrepare()
        prepareFailure?.let { throw it }
        return SyncState.Ready(requireNotNull(previewResponse.snapshot), previewResponse.total)
    }

    override suspend fun preview(query: String): SearchResults {
        previews.add(query)
        val result = previewResponse
        beforePreview(query)
        return result
    }

    override suspend fun search(query: String, category: String?, offset: Int): SearchPage {
        val key = requireNotNull(category)
        searches.add(key to offset)
        val result = responses.removeFirst()
        beforeSearch(key)
        return result
    }

    override suspend fun find(phone: CanonicalPhone): Contact? = null

    override suspend fun refresh(): SyncState.Ready {
        refreshes++
        beforeRefresh()
        return prepare()
    }
}
