package page.dial.publicphonebook

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.foundation.text.input.rememberTextFieldState
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp

@Composable
internal fun SearchField(initialQuery: String, changed: (String) -> Unit) {
    val text = rememberTextFieldState(initialText = initialQuery)
    val onChanged by rememberUpdatedState(changed)
    val focus = LocalFocusManager.current
    LaunchedEffect(text) { snapshotFlow { text.text.toString() }.collect { onChanged(it) } }
    OutlinedTextField(
        state = text,
        label = { Text(stringResource(R.string.query_label)) },
        lineLimits = TextFieldLineLimits.SingleLine,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        onKeyboardAction = { focus.clearFocus() },
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
    )
}
