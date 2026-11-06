package page.dial.data

import java.io.File
import java.util.Base64
import org.brotli.dec.BrotliInputStream
import org.json.JSONArray
import org.json.JSONObject

internal class ContractFixtures(private val root: File) {
    private val fixtures =
        JSONArray(File(requireNotNull(System.getProperty("phonebook.fixture"))).readText())

    fun response(revision: String, path: String): JSONObject =
        fixtures.objects().single {
            it.getString("revision") == revision && it.getString("path") == path
        }

    fun listing(revision: String): DatasetListing =
        DatasetListing.parse(parseObject(response(revision, "/api/datasets").getString("body")))

    fun archive(revision: String): Pair<File, ArchiveEntry> {
        val entry = listing(revision).archive
        return binary(revision, entry.path) to entry
    }

    fun binary(revision: String, path: String): File =
        File(root, "$revision-${path.substringAfterLast('/')}").apply {
            writeBytes(Base64.getDecoder().decode(response(revision, path).getString("body")))
        }

    fun decoded(revision: String): String =
        archive(revision).first.inputStream().use { input ->
            BrotliInputStream(input).bufferedReader().use { it.readText() }
        }

    fun delta(): File {
        val fixture = fixtures.objects().single { "directory-delta-" in it.getString("path") }
        return binary(fixture.getString("revision"), fixture.getString("path"))
    }
}
