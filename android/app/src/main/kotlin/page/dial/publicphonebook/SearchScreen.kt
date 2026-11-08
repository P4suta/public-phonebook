package page.dial.publicphonebook

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import page.dial.core.Contact

@Composable
internal fun SearchScreen(
    state: DirectoryUiState,
    model: DirectoryViewModel,
    select: (Contact) -> Unit,
) {
    Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        SearchField(state.query) { query, composing -> model.search(query, composing) }
        val answered = state.hasCurrentResults
        LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
            item(key = "search-status") { SearchStatus(state) { model.search(state.query) } }
            val groups =
                if (answered && state.query.isNotBlank()) state.results.groups else emptyList()
            groups.forEach { group ->
                val category = group.category
                item(key = "category:${category.id}") {
                    Text(
                        stringResource(R.string.category_results, category.label, group.total),
                        style = MaterialTheme.typography.titleLarge,
                        modifier =
                            Modifier.padding(top = 8.dp, bottom = 12.dp).semantics { heading() },
                    )
                    HorizontalDivider(color = MaterialTheme.colorScheme.onSurface)
                }
                items(group.contacts, key = { "${it.snapshot.value}:${it.row}" }) { contact ->
                    ContactRow(contact) { select(contact) }
                }
                if (group.contacts.size < group.total)
                    item(key = "continue:${category.id}") {
                        Column(
                            Modifier.padding(top = 16.dp, bottom = 24.dp),
                            verticalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            if (category.id in state.loadingCategories)
                                Text(stringResource(R.string.loading_more))
                            else {
                                val failed = category.id in state.failedCategories
                                if (failed) Text(stringResource(R.string.more_failed))
                                Action(
                                    stringResource(
                                        if (failed) R.string.retry_more else R.string.more,
                                        category.label,
                                    ),
                                    if (failed) R.drawable.ic_refresh else R.drawable.ic_down,
                                ) {
                                    model.more(category.id)
                                }
                            }
                        }
                    }
            }
        }
    }
}

@Composable
private fun ContactRow(contact: Contact, select: () -> Unit) {
    Surface(
        onClick = select,
        modifier =
            Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("search-result").semantics {
                role = Role.Button
            },
    ) {
        Row(
            Modifier.padding(vertical = 20.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            PhonebookIcon(R.drawable.ic_building)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(contact.name, style = MaterialTheme.typography.titleMedium)
                Text(
                    "${contact.prefecture} ${contact.municipality}",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(contact.phones.first().display, style = MaterialTheme.typography.bodyMedium)
            }
            PhonebookIcon(R.drawable.ic_chevron)
        }
    }
    HorizontalDivider(color = MaterialTheme.colorScheme.onSurface)
}

@Composable
private fun SearchStatus(state: DirectoryUiState, retry: () -> Unit) {
    Column(
        Modifier.padding(bottom = 16.dp).semantics { liveRegion = LiveRegionMode.Polite },
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (state.query.isBlank()) {
            SectionHeading(R.string.search_help)
            Text(
                stringResource(R.string.empty_query),
                style = MaterialTheme.typography.bodyLarge,
            )
            Text(
                stringResource(R.string.search_example),
                style = MaterialTheme.typography.bodyMedium,
            )
        } else if (state.searching) Text(stringResource(R.string.searching))
        else if (state.searchFailed) {
            Text(stringResource(R.string.search_failed))
            Action(R.string.retry_search, R.drawable.ic_refresh) { retry() }
        } else if (state.hasCurrentResults && state.results.total == 0L)
            Text(stringResource(R.string.no_matches))
        else if (state.hasCurrentResults)
            Text(
                stringResource(R.string.results, state.results.total),
                style = MaterialTheme.typography.bodyMedium,
            )
    }
}
