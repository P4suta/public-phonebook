package page.dial.publicphonebook

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

@Composable
fun PhonebookTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val background = if (dark) Color.Black else Color.White
    val foreground = if (dark) Color.White else Color.Black
    val colors =
        lightColorScheme(
            primary = foreground,
            onPrimary = background,
            primaryContainer = background,
            onPrimaryContainer = foreground,
            secondary = foreground,
            onSecondary = background,
            secondaryContainer = background,
            onSecondaryContainer = foreground,
            tertiary = foreground,
            onTertiary = background,
            tertiaryContainer = background,
            onTertiaryContainer = foreground,
            background = background,
            onBackground = foreground,
            surface = background,
            onSurface = foreground,
            surfaceVariant = background,
            onSurfaceVariant = foreground,
            surfaceTint = background,
            inverseSurface = foreground,
            inverseOnSurface = background,
            inversePrimary = background,
            error = foreground,
            onError = background,
            errorContainer = background,
            onErrorContainer = foreground,
            outline = foreground,
            outlineVariant = foreground,
            scrim = foreground,
            surfaceBright = background,
            surfaceDim = background,
            surfaceContainer = background,
            surfaceContainerHigh = background,
            surfaceContainerHighest = background,
            surfaceContainerLow = background,
            surfaceContainerLowest = background,
        )
    MaterialTheme(colorScheme = colors, content = content)
}
