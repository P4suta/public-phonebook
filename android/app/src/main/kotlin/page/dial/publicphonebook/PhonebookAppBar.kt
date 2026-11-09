package page.dial.publicphonebook

import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun PhonebookAppBar(stack: SnapshotStateList<Screen>) {
    val title =
        when (stack.last()) {
            Screen.Search -> R.string.search_title
            Screen.Contact -> R.string.contact_title
            Screen.Settings -> R.string.settings
            Screen.About -> R.string.about
            Screen.Licenses -> R.string.license
        }
    TopAppBar(
        title = {
            Text(
                stringResource(title),
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.semantics { heading() },
            )
        },
        expandedHeight = 64.dp * LocalDensity.current.fontScale.coerceAtLeast(1f),
        navigationIcon = {
            if (stack.size > 1)
                IconAction(R.string.back, R.drawable.ic_back) { stack.removeAt(stack.lastIndex) }
        },
        actions = {
            if (stack.size == 1) {
                IconAction(R.string.settings, R.drawable.ic_settings) { stack += Screen.Settings }
                IconAction(R.string.about, R.drawable.ic_info) { stack += Screen.About }
            }
        },
    )
}
