package page.dial.data

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.URI
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject
import page.dial.core.DirectoryLimits
import page.dial.core.SearchText
import page.dial.core.SnapshotId
import page.dial.core.TransferPolicy

internal fun InputStream.readBounded(maximum: Int): ByteArray {
    requireDirectory(maximum >= 0)
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(minOf(DirectoryLimits.BUFFER_BYTES, maximum.coerceAtLeast(1)))
    while (true) {
        checkInterruption()
        val count = read(buffer)
        if (count < 0) break
        requireDirectory(
            TransferPolicy.chunk(output.size().toLong(), count.toLong(), maximum.toLong())
        )
        output.write(buffer, 0, count)
    }
    return output.toByteArray()
}

private val integerPattern = Regex("0|[1-9][0-9]*")
private const val ASCII_SPACE = 32
private const val ASCII_DELETE = 127
private const val VARIANT_PAIRS = 1133

class InvalidDirectory(message: String) : IOException(message)

internal fun requireDirectory(condition: Boolean) {
    if (!condition) throw InvalidDirectory("Invalid directory data")
}

internal fun JSONObject.count(
    key: String,
    maximum: Long = DirectoryLimits.MAXIMUM_CONTACTS.toLong(),
): Long {
    val value = get(key)
    requireDirectory(value is Number && value.toString().matches(integerPattern))
    val count = getLong(key)
    requireDirectory(count in 0..maximum)
    return count
}

internal fun digest(value: String): SnapshotId =
    SnapshotId.parse(value) ?: throw InvalidDirectory("Invalid digest")

internal fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }

internal fun JSONObject.text(
    key: String,
    maximum: Int = DirectoryLimits.MAXIMUM_TEXT_BYTES,
    empty: Boolean = false,
): String {
    val raw = get(key)
    requireDirectory(raw is String)
    val value = raw as String
    requireDirectory((empty || value.isNotEmpty()) && value.toByteArray().size <= maximum)
    return value
}

internal fun publicUrl(value: String): String {
    val url = java.net.URL(value)
    val host =
        if ('%' in url.host) java.net.URLDecoder.decode(url.host.replace("+", "%2B"), "UTF-8")
        else url.host
    val authorityValid =
        if (host.startsWith("[")) URI("https://$host").host != null
        else
            host.isNotEmpty() &&
                host.none {
                    it.code <= ASCII_SPACE || it.code == ASCII_DELETE || it in "#%/:<>?@[\\]^|"
                }
    requireDirectory(
        value.toByteArray().size <= DirectoryLimits.MAXIMUM_URL_BYTES &&
            url.protocol in listOf("http", "https") &&
            authorityValid &&
            url.userInfo == null &&
            url.port in -1..DirectoryLimits.MAXIMUM_TCP_PORT
    )
    return value
}

internal fun servicePath(value: String): String {
    val uri = URI(value)
    requireDirectory(
        value.length <= DirectoryLimits.MAXIMUM_URL_BYTES &&
            value.startsWith("/api/") &&
            !value.startsWith("//") &&
            uri.scheme == null &&
            uri.rawAuthority == null &&
            uri.fragment == null &&
            uri.normalize() == uri
    )
    return value
}

data class ArchiveEntry(
    val snapshot: SnapshotId,
    val contacts: Long,
    val bytes: Long,
    val sha256: SnapshotId,
    val path: String,
)

data class DatasetListing(val archive: ArchiveEntry, val deltas: String?) {
    companion object {
        fun parse(json: JSONObject): DatasetListing {
            val snapshot = digest(json.getString("snapshot"))
            val contacts = json.count("contacts")
            val known =
                json.getJSONArray("files").objects().filter {
                    it.getString("format") == "public-phonebook-directory/1"
                }
            requireDirectory(known.size == 1)
            val file = known.single()
            requireDirectory(file.getString("file") == "directory.tsv.br")
            val hash = digest(file.getString("sha256"))
            val path = servicePath(file.getString("url"))
            requireDirectory(
                path == "/api/datasets/${snapshot.value}/${hash.value}/directory.tsv.br"
            )
            val entry =
                ArchiveEntry(
                    snapshot,
                    contacts,
                    file.count("bytes", DirectoryLimits.MAXIMUM_TRANSFER_BYTES),
                    hash,
                    path,
                )
            requireDirectory(entry.bytes > 0)
            return DatasetListing(
                entry,
                if (json.has("datasetDeltas")) servicePath(json.getString("datasetDeltas"))
                else null,
            )
        }
    }
}

object FileDigest {
    fun sha256(file: File): SnapshotId {
        val hash = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(DirectoryLimits.BUFFER_BYTES)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                hash.update(buffer, 0, read)
            }
        }
        return digest(hash.digest().joinToString("") { "%02x".format(java.util.Locale.ROOT, it) })
    }
}

object SearchForms {
    fun load(): SearchText {
        val source =
            SearchForms::class.java.getResourceAsStream("/kanji-variants.txt")
                ?: throw InvalidDirectory("Missing search contract")
        val pairs =
            source.bufferedReader().use { reader ->
                Regex("[0-9a-f]+:[0-9a-f]+").findAll(reader.readText()).map { it.value }.toList()
            }
        requireDirectory(pairs.size == VARIANT_PAIRS)
        return SearchText(pairs)
    }
}
