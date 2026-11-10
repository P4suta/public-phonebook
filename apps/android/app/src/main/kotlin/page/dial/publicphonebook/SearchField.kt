package page.dial.publicphonebook

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.foundation.text.input.clearText
import androidx.compose.foundation.text.input.rememberTextFieldState
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp

@Composable
internal fun SearchField(initialQuery: String, changed: (String, Boolean) -> Unit) {
    val text = rememberTextFieldState(initialText = initialQuery)
    val onChanged by rememberUpdatedState(changed)
    val focus = LocalFocusManager.current
    LaunchedEffect(text) {
        snapshotFlow { SearchEdit(text.text.toString(), text.composition != null) }
            .collect { onChanged(it.text, it.composing) }
    }
    OutlinedTextField(
        state = text,
        shape = RectangleShape,
        label = { Text(stringResource(R.string.query_label)) },
        leadingIcon = { PhonebookIcon(R.drawable.ic_search) },
        trailingIcon = {
            if (text.text.isNotEmpty())
                IconAction(R.string.clear_query, R.drawable.ic_close) { text.clearText() }
        },
        lineLimits = TextFieldLineLimits.SingleLine,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        onKeyboardAction = { focus.clearFocus() },
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
    )
}

private data class SearchEdit(val text: String, val composing: Boolean)
