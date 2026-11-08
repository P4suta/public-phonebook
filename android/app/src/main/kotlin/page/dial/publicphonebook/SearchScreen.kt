package page.dial.publicphonebook

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import page.dial.core.Contact

@Composable
internal fun SearchScreen(
    state: DirectoryUiState,
    model: DirectoryViewModel,
    select: (Contact) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SearchField(state.query) { model.search(it) }
        val answered = state.resultQuery == state.query
        if (state.query.isBlank()) Text(stringResource(R.string.empty_query))
        else if (state.searching) Text(stringResource(R.string.searching))
        else if (state.searchFailed) {
            Text(stringResource(R.string.search_failed))
            Action(R.string.retry_search) { model.search(state.query) }
        } else if (answered && state.results.total == 0L) Text(stringResource(R.string.no_matches))
        else if (answered) Text(stringResource(R.string.results, state.results.total))
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val groups =
                if (answered && state.query.isNotBlank()) state.results.groups else emptyList()
            groups.forEach { group ->
                val category = group.category
                item(key = "category:${category.id}") {
                    Text(
                        stringResource(R.string.category_results, category.label, group.total),
                        style = MaterialTheme.typography.titleLarge,
                        modifier = Modifier.padding(top = 16.dp).semantics { heading() },
                    )
                }
                items(group.contacts, key = { "${it.snapshot.value}:${it.row}" }) { contact ->
                    OutlinedButton(
                        onClick = { select(contact) },
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                        border = BorderStroke(1.dp, MaterialTheme.colorScheme.onSurface),
                    ) {
                        Column(Modifier.fillMaxWidth().padding(8.dp)) {
                            Text(contact.name, style = MaterialTheme.typography.titleMedium)
                            Text("${contact.prefecture} ${contact.municipality}")
                            Text(contact.phones.first().display)
                        }
                    }
                }
                if (group.contacts.size < group.total)
                    item(key = "continue:${category.id}") {
                        if (category.id in state.loadingCategories)
                            Text(stringResource(R.string.loading_more))
                        else {
                            val failed = category.id in state.failedCategories
                            if (failed) Text(stringResource(R.string.more_failed))
                            Action(
                                stringResource(
                                    if (failed) R.string.retry_more else R.string.more,
                                    category.label,
                                )
                            ) {
                                model.more(category.id)
                            }
                        }
                    }
            }
        }
    }
}
