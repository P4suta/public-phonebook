package page.dial.publicphonebook

import android.app.role.RoleManager
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.telecom.Call
import android.telecom.CallScreeningService
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import page.dial.core.CallerPolicy
import page.dial.core.CanonicalPhone
import page.dial.core.DirectoryRepository

class PhonebookScreeningService(
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val repository: DirectoryRepository? = null,
) : CallScreeningService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val handler = Handler(Looper.getMainLooper())

    override fun onScreenCall(callDetails: Call.Details) {
        if (callDetails.callDirection != Call.Details.DIRECTION_INCOMING) return
        val response =
            CallResponse.Builder()
                .setDisallowCall(false)
                .setRejectCall(false)
                .setSilenceCall(false)
                .setSkipCallLog(false)
                .setSkipNotification(false)
                .build()
        val sent = AtomicBoolean(false)
        val allow = Runnable {
            if (sent.compareAndSet(false, true)) respondToCall(callDetails, response)
        }
        handler.postDelayed(allow, CallerPolicy.LOOKUP_BUDGET_MILLIS)
        val started = SystemClock.elapsedRealtime()
        scope.launch {
            try {
                val number = incomingNumber(callDetails) ?: return@launch
                val label = lookup(number) ?: return@launch
                display(started, label)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                return@launch
            } finally {
                allow.run()
                handler.removeCallbacks(allow)
            }
        }
    }

    private suspend fun lookup(number: CanonicalPhone): Pair<String, String>? =
        withTimeoutOrNull(CallerPolicy.LOOKUP_BUDGET_MILLIS) {
            withContext(io) {
                if (
                    BuildConfig.QA_ENABLED &&
                        VerificationNumber.matches(this@PhonebookScreeningService, number)
                ) {
                    getString(R.string.verification_label) to ""
                } else {
                    (repository ?: (application as PhonebookApplication).directory)
                        .find(number)
                        ?.let { it.name to it.address }
                }
            }
        }

    private fun display(started: Long, label: Pair<String, String>) {
        val roles = getSystemService(RoleManager::class.java)
        if (
            !CallerPolicy.display(
                started,
                SystemClock.elapsedRealtime(),
                true,
                roles.isRoleHeld(RoleManager.ROLE_CALL_SCREENING),
            )
        )
            return
        startActivity(
            Intent(this, CallerActivity::class.java)
                .putExtra("name", label.first)
                .putExtra("address", label.second)
                .addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_CLEAR_TOP or
                        Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS
                )
        )
    }

    private fun incomingNumber(details: Call.Details): CanonicalPhone? =
        details.handle
            ?.takeIf { it.scheme == "tel" }
            ?.schemeSpecificPart
            ?.let(CanonicalPhone::parse)

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }
}
