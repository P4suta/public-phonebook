package page.dial.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkInfo
import androidx.test.core.app.ApplicationProvider
import java.io.ByteArrayInputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowNetworkInfo

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class SynchronizationTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val root = File(context.noBackupFilesDir, "directory").apply { mkdirs() }
    private val fixtures = ContractFixtures(root)
    private val requests = mutableListOf<String>()
    private var now = 100_000L
    private val network = shadowOf(context.getSystemService(ConnectivityManager::class.java))

    @Before
    fun savedGeneration() {
        val (file, entry) = fixtures.archive("baseline")
        SQLiteDirectory(root, SearchForms.load()).install(file, entry)
    }

    @Test
    fun failedDeltaFallsBackToTheFullArchiveAndPersistsTheCheckDeadline() = runTest {
        unmetered()
        val target = fixtures.listing("updated")
        val open: (URL) -> HttpURLConnection = { url ->
            requests.add(url.file)
            when (url.file) {
                "/api/datasets" ->
                    FakeConnection(
                        200,
                        fixtures.response("updated", url.file).getString("body").byteInputStream(),
                        mapOf("ETag" to "updated"),
                    )
                target.deltas -> FakeConnection(200, "{\"snapshot\":\"invalid\"}".byteInputStream())
                target.archive.path ->
                    FakeConnection(200, fixtures.archive("updated").first.inputStream())
                else -> error("Unexpected path: ${url.file}")
            }
        }
        val dispatcher = StandardTestDispatcher(testScheduler)
        val directory =
            DeviceDirectory(
                context,
                DatasetTransport.ORIGIN,
                io = dispatcher,
                openConnection = open,
                nowSeconds = { now },
            )
        assertEquals(target.archive.snapshot, directory.refresh().snapshot)
        assertEquals(listOf("/api/datasets", target.deltas, target.archive.path), requests)
        now += 86_399
        assertEquals(target.archive.snapshot, directory.refresh().snapshot)
        assertEquals(3, requests.size)
        now++
        val notModified = FakeConnection(304, ByteArrayInputStream(byteArrayOf()))
        val reopened =
            DeviceDirectory(
                context,
                DatasetTransport.ORIGIN,
                io = dispatcher,
                openConnection = {
                    requests.add(it.file)
                    notModified
                },
                nowSeconds = { now },
            )
        assertEquals(target.archive.snapshot, reopened.refresh().snapshot)
        assertEquals("updated", notModified.getRequestProperty("If-None-Match"))
        assertEquals(4, requests.size)
    }

    @Test
    fun meteredListingRemainsPendingUntilAnUnrestrictedConnectionReturns() = runTest {
        val target = fixtures.listing("updated")
        val dispatcher = StandardTestDispatcher(testScheduler)
        val open: (URL) -> HttpURLConnection = { url ->
            requests.add(url.file)
            when (url.file) {
                "/api/datasets" ->
                    FakeConnection(
                        200,
                        fixtures.response("updated", url.file).getString("body").byteInputStream(),
                    )
                target.deltas -> FakeConnection(500, ByteArrayInputStream(byteArrayOf()))
                target.archive.path ->
                    FakeConnection(200, fixtures.archive("updated").first.inputStream())
                else -> error("Unexpected path: ${url.file}")
            }
        }
        val directory =
            DeviceDirectory(
                context,
                DatasetTransport.ORIGIN,
                io = dispatcher,
                openConnection = open,
                nowSeconds = { now },
            )
        assertEquals(fixtures.listing("baseline").archive.snapshot, directory.refresh().snapshot)
        assertEquals(listOf("/api/datasets"), requests)
        unmetered()
        network.setRestrictBackgroundStatus(ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED)
        directory.refresh()
        assertEquals(listOf("/api/datasets"), requests)
        network.setRestrictBackgroundStatus(ConnectivityManager.RESTRICT_BACKGROUND_STATUS_DISABLED)
        val reopened =
            DeviceDirectory(
                context,
                DatasetTransport.ORIGIN,
                io = dispatcher,
                openConnection = open,
                nowSeconds = { now },
            )
        assertEquals(target.archive.snapshot, reopened.refresh().snapshot)
        assertEquals(listOf("/api/datasets", target.deltas, target.archive.path), requests)
        assertTrue(File(root, "downloads").listFiles()!!.isEmpty())
    }

    @Test
    fun disabledSyncUsesTheSavedGenerationWithoutMakingARequest() = runTest {
        val directory =
            DeviceDirectory(
                context,
                DatasetTransport.ORIGIN,
                syncEnabled = false,
                io = StandardTestDispatcher(testScheduler),
                openConnection = { error("Unexpected network request") },
            )
        assertEquals(fixtures.listing("baseline").archive.snapshot, directory.refresh().snapshot)
        assertTrue(directory.search("図書館").total > 0)
    }

    @Test
    fun interruptedDeltaDoesNotStartAnAutomaticFullDownload() = runTest {
        unmetered()
        val target = fixtures.listing("updated")
        val directory =
            DeviceDirectory(
                context,
                DatasetTransport.ORIGIN,
                io = StandardTestDispatcher(testScheduler),
                openConnection = { url ->
                    requests.add(url.file)
                    if (url.file == "/api/datasets")
                        FakeConnection(
                            200,
                            fixtures
                                .response("updated", url.file)
                                .getString("body")
                                .byteInputStream(),
                        )
                    else throw java.io.InterruptedIOException("interrupted delta")
                },
                nowSeconds = { now },
            )
        val failure = runCatching { directory.refresh() }.exceptionOrNull()
        assertTrue(failure is java.io.InterruptedIOException)
        assertEquals(listOf("/api/datasets", target.deltas), requests)
        assertEquals(
            fixtures.listing("baseline").archive.snapshot,
            directory.search("図書館").snapshot,
        )
    }

    @Test
    fun corruptFullDownloadPreservesTheSavedGenerationAndRetriesThePendingUpdate() = runTest {
        unmetered()
        val target = fixtures.listing("updated")
        var corrupt = true
        val directory =
            DeviceDirectory(
                context,
                DatasetTransport.ORIGIN,
                io = StandardTestDispatcher(testScheduler),
                openConnection = { url ->
                    requests.add(url.file)
                    when (url.file) {
                        "/api/datasets" ->
                            FakeConnection(
                                200,
                                fixtures
                                    .response("updated", url.file)
                                    .getString("body")
                                    .byteInputStream(),
                            )
                        target.deltas -> FakeConnection(500, ByteArrayInputStream(byteArrayOf()))
                        target.archive.path ->
                            FakeConnection(
                                200,
                                if (corrupt)
                                    ByteArrayInputStream(ByteArray(target.archive.bytes.toInt()))
                                else fixtures.archive("updated").first.inputStream(),
                            )
                        else -> error("Unexpected path: ${url.file}")
                    }
                },
                nowSeconds = { now },
            )
        assertTrue(runCatching { directory.refresh() }.exceptionOrNull() is java.io.IOException)
        assertEquals(
            fixtures.listing("baseline").archive.snapshot,
            directory.search("図書館").snapshot,
        )
        corrupt = false
        assertEquals(target.archive.snapshot, directory.refresh().snapshot)
        assertEquals(1, requests.count { it == "/api/datasets" })
    }

    @Suppress("DEPRECATION")
    private fun unmetered() {
        network.setActiveNetworkInfo(
            ShadowNetworkInfo.newInstance(
                NetworkInfo.DetailedState.CONNECTED,
                ConnectivityManager.TYPE_WIFI,
                0,
                true,
                true,
            ),
        )
    }
}
