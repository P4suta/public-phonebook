package page.dial.publicphonebook

import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

@Composable
internal fun PhonebookIcon(@DrawableRes icon: Int, description: String? = null) {
    Icon(painterResource(icon), description, Modifier.size(24.dp))
}

@Composable
internal fun IconAction(@StringRes label: Int, @DrawableRes icon: Int, onClick: () -> Unit) {
    IconButton(onClick, modifier = Modifier.size(48.dp)) {
        PhonebookIcon(icon, stringResource(label))
    }
}

@Composable
internal fun Action(
    @StringRes label: Int,
    @DrawableRes icon: Int,
    primary: Boolean = false,
    onClick: () -> Unit,
) {
    Action(stringResource(label), icon, primary, onClick)
}

@Composable
internal fun Action(
    label: String,
    @DrawableRes icon: Int,
    primary: Boolean = false,
    onClick: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    Surface(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).semantics { role = Role.Button },
        shape = RoundedCornerShape(12.dp),
        color = if (primary) colors.onSurface else colors.surface,
        contentColor = if (primary) colors.surface else colors.onSurface,
        border = BorderStroke(1.dp, colors.onSurface),
    ) {
        Row(
            Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            PhonebookIcon(icon)
            Text(label, style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
        }
    }
}

@Composable
internal fun DialogAction(@StringRes label: Int, @DrawableRes icon: Int, onClick: () -> Unit) {
    TextButton(onClick, modifier = Modifier.heightIn(min = 48.dp)) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            PhonebookIcon(icon)
            Text(stringResource(label))
        }
    }
}

@Composable
internal fun SectionHeading(@StringRes label: Int) {
    Text(
        stringResource(label),
        style = MaterialTheme.typography.titleMedium,
        modifier = Modifier.padding(top = 16.dp).semantics { heading() },
    )
}
