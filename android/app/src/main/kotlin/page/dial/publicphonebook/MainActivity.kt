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
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.foundation.text.input.clearText
import androidx.compose.foundation.text.input.rememberTextFieldState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
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
import androidx.compose.ui.Alignment
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
    Scaffold(topBar = { PhonebookAppBar(stack) }) { insets ->
        Box(
            Modifier.fillMaxSize().padding(insets).consumeWindowInsets(insets).imePadding(),
            contentAlignment = Alignment.TopCenter,
        ) {
            NavDisplay(
                backStack = stack,
                onBack = { if (stack.size > 1) stack.removeAt(stack.lastIndex) },
                modifier = Modifier.widthIn(max = 720.dp).fillMaxSize().padding(horizontal = 20.dp),
                entryProvider = entries,
            )
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
        confirmButton = { DialogAction(R.string.close, R.drawable.ic_close, dismiss) },
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
            Column(
                Modifier.verticalScroll(rememberScrollState()).padding(vertical = 24.dp),
                verticalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                Text(stringResource(R.string.preparing))
                Text(stringResource(R.string.offline_setup))
                CircularProgressIndicator(color = MaterialTheme.colorScheme.onSurface)
            }
        is SyncState.Failed ->
            Column(
                Modifier.verticalScroll(rememberScrollState()).padding(vertical = 24.dp),
                verticalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                Text(stringResource(R.string.preparation_failed))
                Action(R.string.retry, R.drawable.ic_refresh, onClick = model::prepare)
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
            DialogAction(
                R.string.open,
                R.drawable.ic_external,
                onClick = {
                    dismiss()
                    try {
                        context.startActivity(action.intent)
                    } catch (_: ActivityNotFoundException) {
                        failed()
                    } catch (_: SecurityException) {
                        failed()
                    }
                },
            )
        },
        dismissButton = { DialogAction(R.string.cancel, R.drawable.ic_close, dismiss) },
    )
}

@Composable
private fun ContactScreen(contact: Contact, external: (Intent, String) -> Unit) {
    LazyColumn(
        contentPadding = PaddingValues(top = 16.dp, bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item { Text(contact.category.label, style = MaterialTheme.typography.bodyMedium) }
        item {
            Text(
                contact.name,
                style = MaterialTheme.typography.headlineSmall,
                modifier = Modifier.semantics { heading() },
            )
        }
        item { SectionHeading(R.string.phone_heading) }
        items(contact.phones) { phone -> PhoneAction(phone, external) }
        item {
            HorizontalDivider(color = MaterialTheme.colorScheme.onSurface)
            SectionHeading(R.string.address_heading)
        }
        item {
            Text(
                contact.address.ifBlank { "${contact.prefecture} ${contact.municipality}" },
                style = MaterialTheme.typography.bodyLarge,
            )
        }
        if (contact.address.isNotBlank())
            item {
                val confirmation = stringResource(R.string.map_confirmation, contact.address)
                Action(R.string.map, R.drawable.ic_place) {
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
                Action(R.string.website, R.drawable.ic_external) {
                    external(Intent(Intent.ACTION_VIEW, url.toUri()), confirmation)
                }
            }
        }
        sourceDetails(contact, external)
    }
}

@Composable
private fun PhoneAction(phone: Phone, external: (Intent, String) -> Unit) {
    val confirmation = stringResource(R.string.dial_confirmation, phone.display)
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(phone.display, style = MaterialTheme.typography.headlineSmall)
        Action(R.string.call, R.drawable.ic_phone, primary = true) {
            external(
                Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", phone.number.value, null)),
                confirmation,
            )
        }
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
    LazyColumn(
        contentPadding = PaddingValues(top = 8.dp, bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item { SectionHeading(R.string.caller_settings) }
        item {
            Text(
                stringResource(if (active) R.string.caller_active else R.string.caller_inactive),
                style = MaterialTheme.typography.titleMedium,
            )
        }
        item {
            Text(
                stringResource(R.string.caller_explanation),
                style = MaterialTheme.typography.bodyLarge,
            )
        }
        if (roles.isRoleAvailable(RoleManager.ROLE_CALL_SCREENING))
            item {
                Action(R.string.choose_caller, R.drawable.ic_phone) {
                    launcher.launch(roles.createRequestRoleIntent(RoleManager.ROLE_CALL_SCREENING))
                }
            }
        else item { Text(stringResource(R.string.caller_unavailable)) }
        datasetSettings(state, model::refresh)
        if (BuildConfig.QA_ENABLED) item { VerificationSettings() }
    }
}

@Composable
private fun VerificationSettings() {
    val context = LocalContext.current
    val number = rememberTextFieldState()
    var message by remember { mutableStateOf<Int?>(null) }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        HorizontalDivider(
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.padding(top = 16.dp),
        )
        SectionHeading(R.string.verification_heading)
        OutlinedTextField(
            state = number,
            lineLimits = TextFieldLineLimits.SingleLine,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
            label = { Text(stringResource(R.string.verification_number)) },
            leadingIcon = { PhonebookIcon(R.drawable.ic_phone) },
            modifier = Modifier.fillMaxWidth(),
        )
        Action(R.string.save_verification, R.drawable.ic_check) {
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
        Action(R.string.clear_verification, R.drawable.ic_delete) {
            VerificationNumber.clear(context)
            number.clearText()
            message = null
        }
        message?.let { Text(stringResource(it)) }
    }
}

private fun LazyListScope.sourceDetails(contact: Contact, external: (Intent, String) -> Unit) {
    item {
        HorizontalDivider(color = MaterialTheme.colorScheme.onSurface)
        SectionHeading(R.string.source_heading)
    }
    item {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(contact.publisher, style = MaterialTheme.typography.bodyLarge)
            Text(
                stringResource(R.string.retrieved, contact.retrievedAt.substringBefore('T')),
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
    item {
        Action(R.string.source, R.drawable.ic_external) {
            external(Intent(Intent.ACTION_VIEW, contact.sourceUrl.toUri()), contact.sourceUrl)
        }
    }
    item { Text(contact.license, style = MaterialTheme.typography.bodyMedium) }
    item {
        Action(R.string.license, R.drawable.ic_document) {
            external(Intent(Intent.ACTION_VIEW, contact.licenseUrl.toUri()), contact.licenseUrl)
        }
    }
}

private fun LazyListScope.datasetSettings(state: DirectoryUiState, refresh: () -> Unit) {
    item {
        HorizontalDivider(
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.padding(top = 16.dp),
        )
        SectionHeading(R.string.update_heading)
    }
    (state.sync as? SyncState.Ready)?.let { ready ->
        item {
            Text(
                stringResource(R.string.saved_count, ready.contacts),
                style = MaterialTheme.typography.titleMedium,
            )
        }
    }
    item {
        Text(
            stringResource(R.string.update_explanation),
            style = MaterialTheme.typography.bodyLarge,
        )
    }
    item { Action(R.string.update, R.drawable.ic_refresh, onClick = refresh) }
    if (state.updating) item { Text(stringResource(R.string.updating)) }
    state.updateMessage?.let { message -> item { Text(stringResource(message)) } }
}
