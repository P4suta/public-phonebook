package page.dial.publicphonebook

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import page.dial.core.Contact
import page.dial.core.DirectoryRepository
import page.dial.core.PagePolicy
import page.dial.core.SearchGroup
import page.dial.core.SearchResults
import page.dial.core.SnapshotId
import page.dial.core.SyncState

data class DirectoryUiState(
    val sync: SyncState = SyncState.Preparing,
    val query: String = "",
    val resultQuery: String? = null,
    val results: SearchResults = SearchResults(emptyList(), null),
    val searching: Boolean = false,
    val composing: Boolean = false,
    val searchFailed: Boolean = false,
    val expandedCategories: Set<String> = emptySet(),
    val loadingCategories: Set<String> = emptySet(),
    val failedCategories: Set<String> = emptySet(),
    val updating: Boolean = false,
    val updateMessage: Int? = null,
    val selected: Contact? = null,
) {
    val hasCurrentResults: Boolean
        get() = !composing && resultQuery == query
}

class DirectoryViewModel(
    private val repository: DirectoryRepository,
    private val saved: SavedStateHandle,
) : ViewModel() {
    private val state = MutableStateFlow(DirectoryUiState(query = saved["query"] ?: ""))
    val uiState = state.asStateFlow()
    private var searchJob: Job? = null
    private var searchRun = SearchRun()
    private val categoryJobs = mutableMapOf<String, Job>()

    init {
        prepare()
    }

    fun prepare() {
        state.value = state.value.copy(sync = SyncState.Preparing)
        viewModelScope.launch {
            try {
                val ready = repository.prepare()
                state.value = state.value.copy(sync = ready)
                search(state.value.query, state.value.composing)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                state.value = state.value.copy(sync = SyncState.Failed(null))
            }
        }
    }

    fun search(query: String, composing: Boolean = false) {
        searchJob?.cancel()
        categoryJobs.values.forEach { it.cancel() }
        categoryJobs.clear()
        val run = SearchRun()
        searchRun = run
        saved["query"] = query
        state.value =
            state.value.copy(
                query = query,
                searching = !composing,
                composing = composing,
                searchFailed = false,
                expandedCategories = emptySet(),
                loadingCategories = emptySet(),
                failedCategories = emptySet(),
            )
        if (composing) return
        searchJob = viewModelScope.launch {
            try {
                delay(SEARCH_SETTLE_MILLIS)
                val results = repository.preview(query)
                if (searchRun !== run) return@launch
                state.value =
                    state.value.copy(results = results, resultQuery = query, searching = false)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                if (searchRun === run)
                    state.value = state.value.copy(searching = false, searchFailed = true)
            }
        }
    }

    fun more(category: String) {
        val query = state.value.query
        if (
            state.value.searching ||
                !state.value.hasCurrentResults ||
                category in state.value.loadingCategories
        )
            return
        val previous =
            state.value.results.groups
                .firstOrNull { it.category.id == category }
                ?.takeIf { it.contacts.size < it.total } ?: return
        val run = searchRun
        val snapshot = state.value.results.snapshot
        val continuing =
            PagePolicy.canAppend(
                category in state.value.expandedCategories,
                state.value.resultQuery == query,
            )
        val request = CategoryRequest(query, category, previous, run, snapshot, continuing)
        state.value =
            state.value.copy(
                loadingCategories = state.value.loadingCategories + category,
                failedCategories = state.value.failedCategories - category,
            )
        categoryJobs[category] = viewModelScope.launch { loadCategory(request) }
    }

    private suspend fun loadCategory(request: CategoryRequest) {
        val query = request.query
        val category = request.category
        val previous = request.previous
        val run = request.run
        val snapshot = request.snapshot
        val continuing = request.continuing
        val offset = if (continuing) previous.contacts.size else 0
        try {
            val result = repository.search(query, category, offset)
            if (searchRun !== run) return
            if (PagePolicy.restart(true, snapshot, result.snapshot)) {
                search(query)
                return
            }
            require(
                result.total == previous.total &&
                    result.contacts.all { it.category.id == category },
            )
            val contacts = if (continuing) previous.contacts + result.contacts else result.contacts
            state.value =
                state.value.copy(
                    results =
                        state.value.results.copy(
                            groups =
                                state.value.results.groups.map {
                                    if (it.category.id == category) it.copy(contacts = contacts)
                                    else it
                                },
                        ),
                    expandedCategories = state.value.expandedCategories + category,
                )
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            if (searchRun === run)
                state.value =
                    state.value.copy(failedCategories = state.value.failedCategories + category)
        } finally {
            if (searchRun === run) {
                state.value =
                    state.value.copy(loadingCategories = state.value.loadingCategories - category)
                categoryJobs.remove(category)
            }
        }
    }

    fun select(contact: Contact?) {
        state.value = state.value.copy(selected = contact)
    }

    fun refresh() {
        if (state.value.updating) return
        state.value = state.value.copy(updating = true, updateMessage = null)
        viewModelScope.launch {
            try {
                val ready = repository.refresh()
                state.value =
                    state.value.copy(
                        sync = ready,
                        updating = false,
                        updateMessage = R.string.update_done,
                    )
                search(state.value.query, state.value.composing)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                state.value =
                    state.value.copy(updating = false, updateMessage = R.string.update_failed)
            }
        }
    }

    companion object {
        private const val SEARCH_SETTLE_MILLIS = 180L
    }
}

private class SearchRun

private data class CategoryRequest(
    val query: String,
    val category: String,
    val previous: SearchGroup,
    val run: SearchRun,
    val snapshot: SnapshotId?,
    val continuing: Boolean,
)
