package page.dial.publicphonebook

import android.app.role.RoleManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.foundation.text.input.clearText
import androidx.compose.foundation.text.input.rememberTextFieldState
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.navigation3.runtime.NavEntry
import androidx.navigation3.ui.NavDisplay
import page.dial.core.CanonicalPhone
import page.dial.core.Contact
import page.dial.core.Phone
import page.dial.core.SyncState

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val app = application as PhonebookApplication
        setContent {
            val model: DirectoryViewModel =
                viewModel(
                    factory =
                        viewModelFactory {
                            initializer {
                                DirectoryViewModel(app.directory, createSavedStateHandle())
                            }
                        }
                )
            PhonebookTheme { Phonebook(model) { app.scheduleUpdates() } }
        }
    }
}

private data class ExternalAction(val intent: Intent, val explanation: String)

@Composable
private fun Phonebook(model: DirectoryViewModel, prepared: () -> Unit) {
    val state by model.uiState.collectAsStateWithLifecycle()
    val stack = rememberSaveable(saver = screenStackSaver) { mutableStateListOf(Screen.Search) }
    var pending by remember { mutableStateOf<ExternalAction?>(null) }
    var externalFailed by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(state.selected) {
        if (restoredContactIsMissing(stack, state.selected)) stack.removeAt(stack.lastIndex)
    }
    LaunchedEffect(state.sync) { if (state.sync is SyncState.Ready) prepared() }
    fun external(intent: Intent, message: String) {
        pending = ExternalAction(intent, message)
    }
    val entries = rememberEntries(stack, model, ::external)
    Surface(Modifier.fillMaxSize()) {
        Column(
            Modifier.safeDrawingPadding().imePadding().fillMaxSize().padding(horizontal = 20.dp)
        ) {
            Text(
                stringResource(R.string.app_name),
                style = MaterialTheme.typography.headlineMedium,
                modifier = Modifier.padding(vertical = 16.dp).semantics { heading() },
            )
            if (stack.size > 1) Action(R.string.back) { stack.removeAt(stack.lastIndex) }
            NavDisplay(
                backStack = stack,
                onBack = { if (stack.size > 1) stack.removeAt(stack.lastIndex) },
                modifier = Modifier.weight(1f),
                entryProvider = entries,
            )
            if (stack.size == 1)
                Column {
                    HorizontalDivider(color = MaterialTheme.colorScheme.onSurface)
                    Action(R.string.settings) { stack += Screen.Settings }
                    Action(R.string.about) { stack += Screen.About }
                }
        }
    }
    pending?.let { action ->
        ConfirmationDialog(action, { pending = null }, { externalFailed = true })
    }
    if (externalFailed) ExternalFailure { externalFailed = false }
}

@Composable
private fun rememberEntries(
    stack: SnapshotStateList<Screen>,
    model: DirectoryViewModel,
    external: (Intent, String) -> Unit,
): (Screen) -> NavEntry<Screen> {
    val action = rememberUpdatedState(external)
    return remember(model, stack) {
        { screen ->
            NavEntry(screen) {
                val state by model.uiState.collectAsStateWithLifecycle()
                when (screen) {
                    Screen.Search ->
                        SearchDestination(state, model) { contact ->
                            model.select(contact)
                            stack += Screen.Contact
                        }
                    Screen.Contact ->
                        state.selected?.let { contact -> ContactScreen(contact, action.value) }
                    Screen.Settings -> SettingsScreen(state, model)
                    Screen.About -> AboutScreen(action.value) { stack += Screen.Licenses }
                    Screen.Licenses -> LicenseScreen()
                }
            }
        }
    }
}

@Composable
private fun ExternalFailure(dismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = dismiss,
        text = { Text(stringResource(R.string.no_external_app)) },
        confirmButton = { TextButton(onClick = dismiss) { Text(stringResource(R.string.close)) } },
    )
}

@Composable
private fun SearchDestination(
    state: DirectoryUiState,
    model: DirectoryViewModel,
    select: (Contact) -> Unit,
) {
    when (state.sync) {
        SyncState.Preparing ->
            Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
                Text(stringResource(R.string.preparing))
                Text(stringResource(R.string.offline_setup))
                CircularProgressIndicator(color = MaterialTheme.colorScheme.onSurface)
            }
        is SyncState.Failed ->
            Column {
                Text(stringResource(R.string.preparation_failed))
                Action(R.string.retry, model::prepare)
            }
        else -> SearchScreen(state, model, select)
    }
}

@Composable
private fun ConfirmationDialog(action: ExternalAction, dismiss: () -> Unit, failed: () -> Unit) {
    val context = LocalContext.current
    AlertDialog(
        onDismissRequest = dismiss,
        title = { Text(stringResource(R.string.external_title)) },
        text = { Text(action.explanation) },
        confirmButton = {
            TextButton(
                onClick = {
                    dismiss()
                    try {
                        context.startActivity(action.intent)
                    } catch (_: ActivityNotFoundException) {
                        failed()
                    } catch (_: SecurityException) {
                        failed()
                    }
                }
            ) {
                Text(stringResource(R.string.open))
            }
        },
        dismissButton = { TextButton(onClick = dismiss) { Text(stringResource(R.string.cancel)) } },
    )
}

@Composable
internal fun Action(label: Int, onClick: () -> Unit) {
    Action(stringResource(label), onClick)
}

@Composable
internal fun Action(label: String, onClick: () -> Unit) {
    OutlinedButton(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.onSurface),
    ) {
        Text(label)
    }
}

@Composable
private fun ContactScreen(contact: Contact, external: (Intent, String) -> Unit) {
    LazyColumn(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item {
            Text(
                contact.name,
                style = MaterialTheme.typography.headlineSmall,
                modifier = Modifier.semantics { heading() },
            )
        }
        item {
            Text(contact.category.label)
            Text("${contact.prefecture} ${contact.municipality}")
            Text(contact.address)
        }
        items(contact.phones) { phone -> PhoneAction(phone, external) }
        if (contact.address.isNotBlank())
            item {
                val confirmation = stringResource(R.string.map_confirmation, contact.address)
                Action(R.string.map) {
                    external(
                        Intent(
                            Intent.ACTION_VIEW,
                            "geo:0,0?q=${Uri.encode(contact.address)}".toUri(),
                        ),
                        confirmation,
                    )
                }
            }
        contact.website?.let { url ->
            item {
                val confirmation = stringResource(R.string.web_confirmation, url)
                Action(R.string.website) {
                    external(Intent(Intent.ACTION_VIEW, url.toUri()), confirmation)
                }
            }
        }
        item {
            Text(contact.publisher)
            Text(stringResource(R.string.retrieved, contact.retrievedAt))
        }
        item {
            Action(R.string.source) {
                external(Intent(Intent.ACTION_VIEW, contact.sourceUrl.toUri()), contact.sourceUrl)
            }
        }
        item {
            Text(contact.license)
            Action(R.string.license) {
                external(Intent(Intent.ACTION_VIEW, contact.licenseUrl.toUri()), contact.licenseUrl)
            }
        }
    }
}

@Composable
private fun PhoneAction(phone: Phone, external: (Intent, String) -> Unit) {
    val confirmation = stringResource(R.string.dial_confirmation, phone.display)
    Text(phone.display)
    Action(R.string.call) {
        external(
            Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", phone.number.value, null)),
            confirmation,
        )
    }
}

@Composable
private fun SettingsScreen(state: DirectoryUiState, model: DirectoryViewModel) {
    val context = LocalContext.current
    val roles = context.getSystemService(RoleManager::class.java)
    var active by remember { mutableStateOf(roles.isRoleHeld(RoleManager.ROLE_CALL_SCREENING)) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        active = roles.isRoleHeld(RoleManager.ROLE_CALL_SCREENING)
    }
    val launcher =
        rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            active = roles.isRoleHeld(RoleManager.ROLE_CALL_SCREENING)
        }
    LazyColumn(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item {
            Text(
                stringResource(R.string.caller_settings),
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.semantics { heading() },
            )
        }
        item {
            Text(stringResource(R.string.caller_explanation))
            Text(stringResource(if (active) R.string.caller_active else R.string.caller_inactive))
        }
        if (roles.isRoleAvailable(RoleManager.ROLE_CALL_SCREENING))
            item {
                Action(R.string.choose_caller) {
                    launcher.launch(roles.createRequestRoleIntent(RoleManager.ROLE_CALL_SCREENING))
                }
            }
        else item { Text(stringResource(R.string.caller_unavailable)) }
        item { Text(stringResource(R.string.update_explanation)) }
        item { Action(R.string.update, model::refresh) }
        if (state.updating) item { Text(stringResource(R.string.updating)) }
        state.updateMessage?.let { message -> item { Text(stringResource(message)) } }
        (state.sync as? SyncState.Ready)?.let { ready ->
            item { Text(stringResource(R.string.saved_count, ready.contacts)) }
        }
        if (BuildConfig.QA_ENABLED) item { VerificationSettings() }
    }
}

@Composable
private fun VerificationSettings() {
    val context = LocalContext.current
    val number = rememberTextFieldState()
    var message by remember { mutableStateOf<Int?>(null) }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        OutlinedTextField(
            state = number,
            lineLimits = TextFieldLineLimits.SingleLine,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
            label = { Text(stringResource(R.string.verification_number)) },
            modifier = Modifier.fillMaxWidth(),
        )
        Action(R.string.save_verification) {
            val canonical = CanonicalPhone.parse(number.text.toString())
            if (canonical == null) message = R.string.verification_invalid
            else {
                message =
                    try {
                        VerificationNumber.save(context, canonical)
                        number.clearText()
                        R.string.verification_saved
                    } catch (_: java.io.IOException) {
                        R.string.verification_failed
                    }
            }
        }
        Action(R.string.clear_verification) {
            VerificationNumber.clear(context)
            number.clearText()
            message = null
        }
        message?.let { Text(stringResource(it)) }
    }
}
