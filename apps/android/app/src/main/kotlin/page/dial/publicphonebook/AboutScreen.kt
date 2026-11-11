package page.dial.publicphonebook

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@Composable
internal fun AboutScreen(external: (Intent, String) -> Unit, licenses: () -> Unit) {
    LazyColumn(
        contentPadding = PaddingValues(top = 16.dp, bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        item {
            Text(
                stringResource(R.string.app_name),
                style = MaterialTheme.typography.headlineSmall,
                modifier = Modifier.semantics { heading() },
            )
        }
        item { Text(stringResource(R.string.version, BuildConfig.VERSION_NAME)) }
        item { SectionHeading(R.string.about_caller_heading) }
        item {
            Text(stringResource(R.string.about_caller), style = MaterialTheme.typography.bodyLarge)
        }
        openSourceInformation(external)
        item { SectionHeading(R.string.privacy_heading) }
        item { Text(stringResource(R.string.privacy), style = MaterialTheme.typography.bodyLarge) }
        item {
            Action(R.string.privacy_policy, R.drawable.ic_document) {
                val url = "${BuildConfig.ORIGIN}/privacy"
                external(Intent(Intent.ACTION_VIEW, url.toUri()), url)
            }
        }
        item { SectionHeading(R.string.source_heading) }
        item {
            Text(stringResource(R.string.data_notice), style = MaterialTheme.typography.bodyLarge)
        }
        item { Action(R.string.software_licenses, R.drawable.ic_document, onClick = licenses) }
        item {
            Action(R.string.application_website, R.drawable.ic_external) {
                external(Intent(Intent.ACTION_VIEW, BuildConfig.ORIGIN.toUri()), BuildConfig.ORIGIN)
            }
        }
    }
}

private fun LazyListScope.openSourceInformation(external: (Intent, String) -> Unit) {
    item { SectionHeading(R.string.free_heading) }
    item {
        Text(
            stringResource(R.string.open_source_description),
            style = MaterialTheme.typography.bodyLarge,
        )
    }
    item {
        val url = "https://github.com/P4suta/public-phonebook"
        val confirmation = stringResource(R.string.source_code_confirmation, url)
        Action(R.string.source_code, R.drawable.ic_external) {
            external(Intent(Intent.ACTION_VIEW, url.toUri()), confirmation)
        }
    }
}

@Composable
internal fun LicenseScreen(io: CoroutineDispatcher = Dispatchers.IO) {
    val context = LocalContext.current.applicationContext
    val missing = stringResource(R.string.licenses_unavailable)
    val text by
        produceState("", context) {
            value =
                withContext(io) {
                    try {
                        context.assets.open("OSS-NOTICES.txt").bufferedReader().use {
                            it.readText()
                        }
                    } catch (_: java.io.IOException) {
                        missing
                    }
                }
        }
    LazyColumn(contentPadding = PaddingValues(top = 16.dp, bottom = 32.dp)) {
        item { Text(text, style = MaterialTheme.typography.bodyLarge) }
    }
}
