package page.dial.publicphonebook

import android.app.Application
import android.app.role.RoleManager
import android.net.Uri
import android.os.Looper
import android.telecom.Call
import android.telecom.CallScreeningService
import java.time.Duration
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ServiceController
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.LooperMode
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowRoleManager
import org.robolectric.shadows.ShadowService
import org.robolectric.util.ReflectionHelpers
import page.dial.core.CanonicalPhone
import page.dial.core.Contact
import page.dial.core.DirectoryRepository
import page.dial.core.SearchPage
import page.dial.core.SearchResults
import page.dial.core.SyncState

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [29],
    application = Application::class,
    shadows = [RecordingScreeningShadow::class],
)
@LooperMode(LooperMode.Mode.PAUSED)
class ScreeningServiceTest {
    @Before
    fun mainDispatcher() {
        Dispatchers.setMain(StandardTestDispatcher())
    }

    @After
    fun resetDispatcher() {
        Dispatchers.resetMain()
    }

    @Test
    fun independentPermissionDeadlineWorksBeforeTheLookupCoroutineStarts() = runTest {
        val controller = service(StandardTestDispatcher(testScheduler))
        try {
            val service = controller.get()
            service.onScreenCall(details("tel:0312345678"))
            assertTrue(responses(service).isEmpty())
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(999))
            assertTrue(responses(service).isEmpty())
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1))
            assertAllowedOnce(service)
            advanceUntilIdle()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(5))
            assertAllowedOnce(service)
        } finally {
            controller.destroy()
        }
    }

    @Test
    fun missingInvalidAndUnreadyLookupsAlwaysPermitTheCall() = runTest {
        for (number in listOf(null, "sip:0312345678", "tel:110", "tel:0312345678")) {
            val controller = service(StandardTestDispatcher(testScheduler))
            try {
                controller.get().onScreenCall(details(number))
                advanceUntilIdle()
                assertAllowedOnce(controller.get())
            } finally {
                controller.destroy()
            }
        }
    }

    @Test
    fun destroyingTheServiceBeforeCoroutineDispatchStillPermitsTheCall() = runTest {
        val controller = service(StandardTestDispatcher(testScheduler))
        val service = controller.get()
        service.onScreenCall(details("tel:0312345678"))
        controller.destroy()
        advanceUntilIdle()
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1))
        assertAllowedOnce(service)
    }

    @Test
    fun outgoingCallsDoNotEnterIncomingScreening() = runTest {
        val controller = service(StandardTestDispatcher(testScheduler))
        try {
            controller
                .get()
                .onScreenCall(details("tel:0312345678", Call.Details.DIRECTION_OUTGOING))
            advanceUntilIdle()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(5))
            assertTrue(responses(controller.get()).isEmpty())
        } finally {
            controller.destroy()
        }
    }

    @Test
    fun repositoryFailureDuringLookupStillPermitsTheCall() = runTest {
        val controller =
            service(StandardTestDispatcher(testScheduler)) {
                throw java.io.IOException("Unavailable storage")
            }
        try {
            controller.get().onScreenCall(details("tel:0312345678"))
            advanceUntilIdle()
            assertAllowedOnce(controller.get())
        } finally {
            controller.destroy()
        }
    }

    @Test
    fun lookupTimeoutCancelsPendingWorkAndPermitsTheCall() = runTest {
        var cancelled = false
        val controller =
            service(StandardTestDispatcher(testScheduler)) {
                try {
                    awaitCancellation()
                } finally {
                    cancelled = true
                }
            }
        try {
            controller.get().onScreenCall(details("tel:0312345678"))
            runCurrent()
            assertTrue(responses(controller.get()).isEmpty())
            advanceTimeBy(1000)
            runCurrent()
            assertTrue(cancelled)
            assertAllowedOnce(controller.get())
        } finally {
            controller.destroy()
        }
    }

    @Test
    fun aLocalMatchRequiresTheScreeningRoleBeforeDisplayingAFacility() = runTest {
        val controller = service(StandardTestDispatcher(testScheduler))
        val service = controller.get()
        try {
            ShadowRoleManager.addRoleHolder(
                RoleManager.ROLE_CALL_SCREENING,
                "another.test.app",
                android.os.Process.myUserHandle(),
            )
            VerificationNumber.save(service, requireNotNull(CanonicalPhone.parse("0312345678")))
            service.onScreenCall(details("tel:0312345678"))
            advanceUntilIdle()
            assertEquals(null, shadowOf(service.application).nextStartedActivity)
            ShadowRoleManager.addRoleHolder(
                RoleManager.ROLE_CALL_SCREENING,
                service.packageName,
                android.os.Process.myUserHandle(),
            )
            service.onScreenCall(details("tel:0312345678"))
            advanceUntilIdle()
            val intent = requireNotNull(shadowOf(service.application).nextStartedActivity)
            assertEquals(CallerActivity::class.java.name, intent.component?.className)
            assertEquals(
                service.getString(R.string.verification_label),
                intent.getStringExtra("name"),
            )
            assertEquals(2, responses(service).size)
            service.onScreenCall(details("tel:0312345678"))
            ShadowRoleManager.removeRoleHolder(
                RoleManager.ROLE_CALL_SCREENING,
                service.packageName,
                android.os.Process.myUserHandle(),
            )
            advanceUntilIdle()
            assertEquals(null, shadowOf(service.application).nextStartedActivity)
            assertEquals(3, responses(service).size)
        } finally {
            VerificationNumber.clear(service)
            controller.destroy()
        }
    }

    private fun service(
        dispatcher: CoroutineDispatcher,
        find: suspend (CanonicalPhone) -> Contact? = { null },
    ) =
        ServiceController.of(PhonebookScreeningService(dispatcher, LookupRepository(find)), null)
            .create()

    private fun details(
        number: String?,
        direction: Int = Call.Details.DIRECTION_INCOMING,
    ): Call.Details =
        Shadow.newInstanceOf(Call.Details::class.java).apply {
            ReflectionHelpers.setField(this, "mCallDirection", direction)
            ReflectionHelpers.setField(this, "mHandle", number?.let(Uri::parse))
        }

    private fun responses(
        service: PhonebookScreeningService
    ): List<CallScreeningService.CallResponse> =
        Shadow.extract<RecordingScreeningShadow>(service).responses

    private fun assertAllowedOnce(service: PhonebookScreeningService) {
        val responses = responses(service)
        assertEquals(1, responses.size)
        with(responses.single()) {
            assertFalse(disallowCall)
            assertFalse(rejectCall)
            assertFalse(silenceCall)
            assertFalse(skipCallLog)
            assertFalse(skipNotification)
        }
    }
}

@Implements(CallScreeningService::class)
class RecordingScreeningShadow : ShadowService() {
    val responses = mutableListOf<CallScreeningService.CallResponse>()

    @Implementation
    fun respondToCall(details: Call.Details, response: CallScreeningService.CallResponse) {
        check(details.callDirection == Call.Details.DIRECTION_INCOMING)
        responses.add(response)
    }
}

private class LookupRepository(private val lookup: suspend (CanonicalPhone) -> Contact?) :
    DirectoryRepository {
    override suspend fun find(phone: CanonicalPhone): Contact? = lookup(phone)

    override suspend fun prepare(): SyncState.Ready = error("Unexpected preparation")

    override suspend fun refresh(): SyncState.Ready = error("Unexpected refresh")

    override suspend fun search(query: String, category: String?, offset: Int): SearchPage =
        error("Unexpected search")

    override suspend fun preview(query: String): SearchResults = error("Unexpected preview")
}
