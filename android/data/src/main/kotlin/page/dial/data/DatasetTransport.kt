package page.dial.data

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject
import page.dial.core.DirectoryLimits
import page.dial.core.SnapshotId
import page.dial.core.TransferPolicy

internal class DatasetTransport(
    origin: String,
    private val permitted: () -> Boolean,
    private val open: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
) {
    init {
        require(origin == ORIGIN)
    }

    private fun connection(path: String): HttpURLConnection =
        open(URL(ORIGIN + servicePath(path))).apply {
            instanceFollowRedirects = false
            connectTimeout = CONNECT_TIMEOUT_MILLIS
            readTimeout = READ_TIMEOUT_MILLIS
            setRequestProperty("Accept-Encoding", "identity")
        }

    data class Reply(val body: JSONObject?, val etag: String?)

    fun json(path: String, etag: String? = null): Reply {
        val connection = connection(path)
        return connection.useConnection {
            etag?.let { connection.setRequestProperty("If-None-Match", it) }
            val code = connection.responseCode
            val next =
                connection.getHeaderField("ETag")?.takeIf {
                    it.length <= DirectoryLimits.MAXIMUM_ETAG_CHARACTERS
                }
            if (code == HttpURLConnection.HTTP_NOT_MODIFIED) Reply(null, next ?: etag)
            else {
                requireDirectory(
                    code == HttpURLConnection.HTTP_OK &&
                        connection.contentEncoding in listOf(null, "identity")
                )
                Reply(connection.inputStream.use { it.readObject() }, next)
            }
        }
    }

    fun download(path: String, bytes: Long, sha256: SnapshotId, file: File): File {
        requireDirectory(bytes in 1..DirectoryLimits.MAXIMUM_TRANSFER_BYTES)
        file.parentFile?.mkdirs()
        if (!(file.exists() && file.length() == bytes && FileDigest.sha256(file) == sha256)) {
            if (file.length() >= bytes) FileOutputStream(file).close()
            transfer(file, path, bytes)
            if (FileDigest.sha256(file) != sha256) {
                requireDirectory(file.delete())
                throw InvalidDirectory("Download digest mismatch")
            }
        }
        return file
    }

    private fun transfer(file: File, path: String, bytes: Long) {
        ensurePermitted()
        val connection = connection(path)
        connection.useConnection {
            var offset = file.length()
            if (offset > 0) connection.setRequestProperty("Range", "bytes=$offset-")
            val code = connection.responseCode
            requireDirectory(connection.contentEncoding in listOf(null, "identity"))
            if (code == HttpURLConnection.HTTP_OK) offset = 0
            else
                requireDirectory(
                    code == HttpURLConnection.HTTP_PARTIAL &&
                        connection.getHeaderField("Content-Range") ==
                            "bytes $offset-${bytes - 1}/$bytes"
                )
            requireDirectory(
                connection.contentLengthLong == -1L ||
                    connection.contentLengthLong == bytes - offset
            )
            FileOutputStream(file, offset > 0).use { output ->
                connection.inputStream.use { input ->
                    val buffer = ByteArray(DirectoryLimits.BUFFER_BYTES)
                    while (true) {
                        ensurePermitted()
                        val count = input.read(buffer)
                        if (count < 0) break
                        requireDirectory(TransferPolicy.chunk(offset, count.toLong(), bytes))
                        output.write(buffer, 0, count)
                        offset += count
                    }
                }
                output.fd.sync()
            }
            requireDirectory(offset == bytes)
        }
    }

    private fun ensurePermitted() {
        checkInterruption()
        if (!permitted()) throw IOException("Transfer is waiting for an unrestricted network")
    }

    companion object {
        const val ORIGIN = "https://www.dial.page"
        private const val CONNECT_TIMEOUT_MILLIS = 15_000
        private const val READ_TIMEOUT_MILLIS = 30_000
    }
}

private inline fun <T> HttpURLConnection.useConnection(block: () -> T): T =
    try {
        block()
    } finally {
        disconnect()
    }
