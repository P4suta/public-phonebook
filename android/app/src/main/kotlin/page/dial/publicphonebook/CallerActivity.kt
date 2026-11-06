package page.dial.publicphonebook

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import page.dial.core.DirectoryLimits

class CallerActivity : ComponentActivity() {
    private val caller = mutableStateOf("" to "")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setShowWhenLocked(true)
        updateCaller(intent)
        setContent {
            PhonebookTheme {
                Surface(Modifier.fillMaxSize()) {
                    Column(
                        Modifier.safeDrawingPadding().padding(24.dp),
                        verticalArrangement = Arrangement.spacedBy(24.dp),
                    ) {
                        Text(
                            stringResource(R.string.app_name),
                            style = MaterialTheme.typography.titleLarge,
                        )
                        Text(
                            stringResource(R.string.incoming),
                            style = MaterialTheme.typography.titleMedium,
                        )
                        Text(caller.value.first, style = MaterialTheme.typography.headlineLarge)
                        if (caller.value.second.isNotEmpty()) Text(caller.value.second)
                        OutlinedButton(
                            onClick = { finish() },
                            modifier = Modifier.heightIn(min = 48.dp),
                        ) {
                            Text(stringResource(R.string.close))
                        }
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        updateCaller(intent)
    }

    private fun updateCaller(intent: Intent) {
        caller.value =
            intent.getStringExtra("name").orEmpty().take(DirectoryLimits.MAXIMUM_NAME_BYTES) to
                intent
                    .getStringExtra("address")
                    .orEmpty()
                    .take(DirectoryLimits.MAXIMUM_ADDRESS_BYTES)
    }
}
