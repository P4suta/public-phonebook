package page.dial.data

import android.content.Context
import android.net.ConnectivityManager
import android.os.CancellationSignal
import android.util.AtomicFile
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InterruptedIOException
import java.net.HttpURLConnection
import java.net.URISyntaxException
import java.net.URL
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONException
import org.json.JSONObject
import page.dial.core.CanonicalPhone
import page.dial.core.Contact
import page.dial.core.DirectoryLimits
import page.dial.core.DirectoryRepository
import page.dial.core.SearchPage
import page.dial.core.SearchResults
import page.dial.core.SyncPolicy
import page.dial.core.SyncState

class DeviceDirectory(
    context: Context,
    origin: String,
    private val syncEnabled: Boolean = true,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    openConnection: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
    private val nowSeconds: () -> Long = {
        System.currentTimeMillis().coerceAtLeast(0) / MILLIS_PER_SECOND
    },
) : DirectoryRepository {
    private val context = context.applicationContext
    private val root = File(context.noBackupFilesDir, "directory").apply { mkdirs() }
    private val store = SQLiteDirectory(root, SearchForms.load())
    private val sync = Mutex()
    private val state = AtomicFile(File(root, "sync.json"))
    private val network = context.getSystemService(ConnectivityManager::class.java)
    private val transport = DatasetTransport(origin, ::transferPermitted, openConnection)

    fun transferPermitted(): Boolean =
        SyncPolicy.transfer(
            network.isActiveNetworkMetered,
            network.restrictBackgroundStatus ==
                ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED,
        )

    override suspend fun prepare(): SyncState.Ready = sync.withLock {
        runInterruptible(io) {
            (store.current() ?: importBundle()).also {
                store.prepareSearch()
                store.retryCleanup()
            }
        }
    }

    private fun importBundle(): SyncState.Ready {
        val declaration = context.assets.open("directory.json").use { it.readObject() }
        val entry =
            ArchiveEntry(
                digest(declaration.getString("snapshot")),
                declaration.count("contacts"),
                declaration.count("bytes", DirectoryLimits.MAXIMUM_TRANSFER_BYTES),
                digest(declaration.getString("sha256")),
                "",
            )
        val bundled = File(root, "bundled.br")
        context.assets.open("directory.tsv.br").use { input ->
            FileOutputStream(bundled).use { output ->
                input.copyTo(output)
                output.fd.sync()
            }
        }
        val ready = store.install(bundled, entry)
        requireDirectory(bundled.delete())
        return ready
    }

    override suspend fun search(query: String, category: String?, offset: Int): SearchPage =
        readQuery(io) { store.search(query, category, offset, it) }

    override suspend fun preview(query: String): SearchResults =
        readQuery(io) { store.preview(query, it) }

    override suspend fun find(phone: CanonicalPhone): Contact? =
        readQuery(io) { store.find(phone, it) }

    private fun readState(): JSONObject =
        try {
            state.openRead().use { it.readObject() }
        } catch (_: java.io.FileNotFoundException) {
            JSONObject()
        }

    private fun checkListing(checkpoint: JSONObject) {
        val now = nowSeconds()
        val last = if (checkpoint.has("answeredAt")) checkpoint.getLong("answeredAt") else null
        if (SyncPolicy.due(last, now)) {
            val reply =
                transport.json(
                    "/api/datasets",
                    checkpoint.optString("etag").takeIf { it.isNotEmpty() },
                )
            reply.body?.let {
                DatasetListing.parse(it)
                checkpoint.put("listing", it)
            }
            checkpoint.put("answeredAt", now)
            reply.etag?.let { checkpoint.put("etag", it) }
            state.replace(checkpoint.toString().toByteArray())
        }
    }

    override suspend fun refresh(): SyncState.Ready = sync.withLock {
        runInterruptible(io) {
            val saved = store.current() ?: throw IOException("Directory is not ready")
            if (!syncEnabled) return@runInterruptible saved
            val checkpoint = readState()
            checkListing(checkpoint)
            val listing = checkpoint.optJSONObject("listing")?.let(DatasetListing::parse)
            if (
                listing == null ||
                    listing.archive.snapshot == saved.snapshot ||
                    !transferPermitted()
            )
                saved
            else {
                val downloads = File(root, "downloads").apply { mkdirs() }
                val rebuilt = tryDelta(listing, saved, downloads)
                val ready =
                    rebuilt?.let(store::install)
                        ?: store.install(
                            transport.download(
                                listing.archive.path,
                                listing.archive.bytes,
                                listing.archive.sha256,
                                File(downloads, "${listing.archive.sha256.value}.part"),
                            ),
                            listing.archive,
                        )
                downloads.listFiles()?.forEach { requireDirectory(it.delete()) }
                checkpoint.remove("listing")
                state.replace(checkpoint.toString().toByteArray())
                ready
            }
        }
    }

    private fun tryDelta(
        listing: DatasetListing,
        saved: SyncState.Ready,
        downloads: File,
    ): RebuiltArchive? =
        try {
            listing.deltas?.let { rebuildDelta(it, listing.archive, saved, downloads) }
        } catch (interrupted: InterruptedIOException) {
            throw interrupted
        } catch (_: IOException) {
            null
        } catch (_: JSONException) {
            null
        } catch (_: IllegalArgumentException) {
            null
        } catch (_: URISyntaxException) {
            null
        }

    private fun rebuildDelta(
        path: String,
        target: ArchiveEntry,
        saved: SyncState.Ready,
        downloads: File,
    ): RebuiltArchive? {
        val deltas = transport.json(path).body ?: throw InvalidDirectory("Missing delta listing")
        requireDirectory(
            digest(deltas.getString("snapshot")) == target.snapshot &&
                digest(deltas.getString("archiveSha256")) == target.sha256
        )
        val candidate =
            deltas.getJSONArray("deltas").objects().firstOrNull {
                it.getString("format") == "public-phonebook-directory-delta/1" &&
                    it.getString("base") == saved.snapshot.value
            }
        return candidate?.let {
            val sha = digest(it.getString("sha256"))
            val delta =
                transport.download(
                    servicePath(it.getString("url")),
                    it.count("bytes", DirectoryLimits.MAXIMUM_TRANSFER_BYTES),
                    sha,
                    File(downloads, "${sha.value}.part"),
                )
            val base = store.activeArchive() ?: throw InvalidDirectory("Missing base archive")
            DirectoryDelta.rebuild(
                base,
                delta,
                File(downloads, "rebuilt.tsv"),
                target,
                DecodedIdentity(
                    it.count("uncompressedBytes", DirectoryLimits.MAXIMUM_DECODED_BYTES),
                    digest(it.getString("uncompressedSha256")),
                ),
            )
        }
    }

    companion object {
        private const val MILLIS_PER_SECOND = 1000
    }
}

private suspend fun <T> readQuery(io: CoroutineDispatcher, read: (CancellationSignal) -> T): T =
    withContext(io) {
        suspendCancellableCoroutine { continuation ->
            val cancellation = CancellationSignal()
            continuation.invokeOnCancellation { cancellation.cancel() }
            continuation.resumeWith(runCatching { read(cancellation) })
        }
    }
