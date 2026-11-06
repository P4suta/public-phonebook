package page.dial.publicphonebook

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.lazy.LazyColumn
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
    LazyColumn(verticalArrangement = Arrangement.spacedBy(20.dp)) {
        item {
            Text(
                stringResource(R.string.about),
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.semantics { heading() },
            )
        }
        item { Text(stringResource(R.string.version, BuildConfig.VERSION_NAME)) }
        item { Text(stringResource(R.string.privacy)) }
        item { Text(stringResource(R.string.connection_metadata)) }
        item { Text(stringResource(R.string.data_notice)) }
        item { Action(R.string.software_licenses, licenses) }
        item {
            Action(R.string.privacy_policy) {
                val url = "${BuildConfig.ORIGIN}/privacy"
                external(Intent(Intent.ACTION_VIEW, url.toUri()), url)
            }
        }
        item {
            Action(R.string.application_website) {
                external(Intent(Intent.ACTION_VIEW, BuildConfig.ORIGIN.toUri()), BuildConfig.ORIGIN)
            }
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
    LazyColumn { item { Text(text) } }
}
