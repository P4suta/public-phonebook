package page.dial.publicphonebook

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
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
import page.dial.core.SearchPage
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
    fun paginationRestartsWhenThePublishedGenerationChanges() = runTest {
        val previous = page("a", 0, 1)
        val updatedTail = page("b", 2)
        val updatedFirst = page("b", 0, 1)
        val repository = Pages(previous, updatedTail, updatedFirst)
        val model = DirectoryViewModel(repository, SavedStateHandle())
        models.put("directory", model)
        advanceUntilIdle()
        model.search("", more = true)
        advanceUntilIdle()
        assertEquals(listOf(0, 2, 0), repository.offsets)
        assertEquals(updatedFirst, model.uiState.value.results)
    }

    @Test
    fun paginationAppendsRowsWithinOneCompleteGeneration() = runTest {
        val repository = Pages(page("a", 0, 1), page("a", 2))
        val model = DirectoryViewModel(repository, SavedStateHandle())
        models.put("directory", model)
        advanceUntilIdle()
        model.search("", more = true)
        advanceUntilIdle()
        assertEquals(listOf(0, 2), repository.offsets)
        assertEquals(listOf(0L, 1L, 2L), model.uiState.value.results.contacts.map { it.row })
    }

    @Test
    fun paginationRestartsWhenTheQueryChangesBeforeItsFirstPageArrives() = runTest {
        val firstNewPage = page("a", 1)
        val repository = Pages(page("a", 0), firstNewPage)
        val model = DirectoryViewModel(repository, SavedStateHandle(mapOf("query" to "previous")))
        models.put("directory", model)
        advanceUntilIdle()
        model.search("requested")
        model.search("requested", more = true)
        advanceUntilIdle()
        assertEquals(listOf(0, 0), repository.offsets)
        assertEquals(firstNewPage, model.uiState.value.results)
    }

    @Test
    fun replacingAnInFlightQueryCancelsOldWorkAndPreservesTheLatestSavedQuery() = runTest {
        val repository = Pages(page("a", 0), page("a", 1))
        var cancelled = false
        repository.beforeSearch = { query ->
            if (query == "slow")
                try {
                    awaitCancellation()
                } finally {
                    cancelled = true
                }
        }
        val saved = SavedStateHandle()
        val model = DirectoryViewModel(repository, saved)
        models.put("directory", model)
        advanceUntilIdle()
        model.search("slow")
        advanceTimeBy(181)
        runCurrent()
        model.search("latest")
        advanceUntilIdle()
        assertTrue(cancelled)
        assertEquals("latest", saved.get<String>("query"))
        assertEquals("latest", model.uiState.value.query)
        assertFalse(model.uiState.value.searching)
        assertFalse(model.uiState.value.searchFailed)
        assertEquals(listOf(1L), model.uiState.value.results.contacts.map { it.row })
    }

    @Test
    fun searchFailureRetainsSavedResultsAndASuccessfulRetryClearsTheFailure() = runTest {
        val initial = page("a", 0)
        val repository = Pages(initial, page("a", 1))
        repository.beforeSearch = { if (it == "bad") throw java.io.IOException("offline") }
        val model = DirectoryViewModel(repository, SavedStateHandle())
        models.put("directory", model)
        advanceUntilIdle()
        model.search("bad")
        advanceUntilIdle()
        assertTrue(model.uiState.value.searchFailed)
        assertFalse(model.uiState.value.searching)
        assertEquals(initial, model.uiState.value.results)
        model.search("retry")
        advanceUntilIdle()
        assertFalse(model.uiState.value.searchFailed)
        assertEquals(listOf(1L), model.uiState.value.results.contacts.map { it.row })
    }

    @Test
    fun preparationCanRetryAfterAnInitialFailure() = runTest {
        val repository = Pages(page("a", 0))
        repository.prepareFailure = java.io.IOException("unavailable storage")
        val model = DirectoryViewModel(repository, SavedStateHandle(mapOf("query" to "restored")))
        models.put("directory", model)
        advanceUntilIdle()
        assertEquals(SyncState.Failed(null), model.uiState.value.sync)
        repository.prepareFailure = null
        model.prepare()
        advanceUntilIdle()
        assertTrue(model.uiState.value.sync is SyncState.Ready)
        assertEquals("restored", model.uiState.value.query)
    }

    @Test
    fun overlappingRefreshesRunOnceAndFailureKeepsSearchAvailable() = runTest {
        val initial = page("a", 0)
        val repository = Pages(initial)
        val waiting = CompletableDeferred<Unit>()
        repository.beforeRefresh = {
            waiting.await()
            throw java.io.IOException("offline")
        }
        val model = DirectoryViewModel(repository, SavedStateHandle())
        models.put("directory", model)
        advanceUntilIdle()
        model.refresh()
        model.refresh()
        runCurrent()
        assertEquals(1, repository.refreshes)
        assertTrue(model.uiState.value.updating)
        assertEquals(initial, model.uiState.value.results)
        waiting.complete(Unit)
        advanceUntilIdle()
        assertFalse(model.uiState.value.updating)
        assertEquals(R.string.update_failed, model.uiState.value.updateMessage)
        assertEquals(initial, model.uiState.value.results)
        assertTrue(model.uiState.value.sync is SyncState.Ready)
    }

    private fun page(identity: String, vararg rows: Long): SearchPage {
        val snapshot = requireNotNull(SnapshotId.parse(identity.repeat(64)))
        return SearchPage(
            rows.map {
                Contact(
                    snapshot,
                    it,
                    Category("library", "Library"),
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
            3,
            snapshot,
        )
    }
}

private class Pages(vararg pages: SearchPage) : DirectoryRepository {
    private val responses = ArrayDeque(pages.toList())
    private val first = pages.first()
    val offsets = mutableListOf<Int>()
    var beforeSearch: suspend (String) -> Unit = {}
    var beforeRefresh: suspend () -> Unit = {}
    var prepareFailure: Exception? = null
    var refreshes = 0

    override suspend fun prepare(): SyncState.Ready {
        prepareFailure?.let { throw it }
        return SyncState.Ready(requireNotNull(first.snapshot), first.total)
    }

    override suspend fun search(query: String, category: String?, offset: Int): SearchPage {
        offsets.add(offset)
        beforeSearch(query)
        return responses.removeFirst()
    }

    override suspend fun find(phone: CanonicalPhone): Contact? = null

    override suspend fun refresh(): SyncState.Ready {
        refreshes++
        beforeRefresh()
        return prepare()
    }
}
