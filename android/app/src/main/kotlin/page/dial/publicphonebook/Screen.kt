package page.dial.publicphonebook

import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.runtime.toMutableStateList
import page.dial.core.Contact

internal enum class Screen {
    Search,
    Contact,
    Settings,
    About,
    Licenses,
}

internal fun restoredContactIsMissing(stack: List<Screen>, selected: Contact?): Boolean =
    stack.last() == Screen.Contact && selected == null

internal val screenStackSaver =
    listSaver<SnapshotStateList<Screen>, String>(
        save = { stack -> stack.map { it.name } },
        restore = { names ->
            names
                .mapNotNull { name -> Screen.entries.firstOrNull { it.name == name } }
                .ifEmpty { listOf(Screen.Search) }
                .toMutableStateList()
        },
    )
