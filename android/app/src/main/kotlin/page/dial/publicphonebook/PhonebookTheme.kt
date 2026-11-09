package page.dial.publicphonebook

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

private val phonebookTypography =
    Typography(
        headlineLarge =
            TextStyle(fontSize = 30.sp, lineHeight = 40.sp, fontWeight = FontWeight.Bold),
        headlineSmall =
            TextStyle(fontSize = 26.sp, lineHeight = 36.sp, fontWeight = FontWeight.Bold),
        titleLarge =
            TextStyle(fontSize = 20.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
        titleMedium =
            TextStyle(fontSize = 18.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
        bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 26.sp),
        bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 22.sp),
        labelLarge =
            TextStyle(fontSize = 16.sp, lineHeight = 24.sp, fontWeight = FontWeight.Medium),
    )

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
    MaterialTheme(colorScheme = colors, typography = phonebookTypography, content = content)
}
