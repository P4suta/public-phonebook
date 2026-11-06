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
import page.dial.core.SearchPage
import page.dial.core.SyncState

data class DirectoryUiState(
    val sync: SyncState = SyncState.Preparing,
    val query: String = "",
    val resultQuery: String? = null,
    val results: SearchPage = SearchPage(emptyList(), 0, null),
    val searching: Boolean = false,
    val searchFailed: Boolean = false,
    val updating: Boolean = false,
    val updateMessage: Int? = null,
    val selected: Contact? = null,
)

class DirectoryViewModel(
    private val repository: DirectoryRepository,
    private val saved: SavedStateHandle,
) : ViewModel() {
    private val state = MutableStateFlow(DirectoryUiState(query = saved["query"] ?: ""))
    val uiState = state.asStateFlow()
    private var searchJob: Job? = null

    init {
        prepare()
    }

    fun prepare() {
        state.value = state.value.copy(sync = SyncState.Preparing)
        viewModelScope.launch {
            try {
                state.value = state.value.copy(sync = repository.prepare())
                search(state.value.query)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                state.value = state.value.copy(sync = SyncState.Failed(null))
            }
        }
    }

    fun search(query: String, more: Boolean = false) {
        searchJob?.cancel()
        saved["query"] = query
        state.value = state.value.copy(query = query, searching = true, searchFailed = false)
        searchJob = viewModelScope.launch {
            try {
                if (!more) delay(SEARCH_SETTLE_MILLIS)
                val results = fetchPage(query, more)
                state.value =
                    state.value.copy(results = results, resultQuery = query, searching = false)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                state.value = state.value.copy(searching = false, searchFailed = true)
            }
        }
    }

    private suspend fun fetchPage(query: String, more: Boolean): SearchPage {
        val previous = state.value.results
        val continuing = PagePolicy.canAppend(more, state.value.resultQuery == query)
        val offset = if (continuing) previous.contacts.size else 0
        val result = repository.search(query, offset = offset)
        return if (PagePolicy.restart(continuing, previous.snapshot, result.snapshot))
            repository.search(query)
        else if (continuing) result.copy(contacts = previous.contacts + result.contacts) else result
    }

    fun select(contact: Contact?) {
        state.value = state.value.copy(selected = contact)
    }

    fun refresh() {
        if (state.value.updating) return
        state.value = state.value.copy(updating = true, updateMessage = null)
        viewModelScope.launch {
            try {
                state.value =
                    state.value.copy(
                        sync = repository.refresh(),
                        updating = false,
                        updateMessage = R.string.update_done,
                    )
                search(state.value.query)
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
