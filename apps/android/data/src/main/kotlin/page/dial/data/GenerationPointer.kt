package page.dial.data

import android.util.AtomicFile
import java.io.FileNotFoundException
import org.json.JSONObject

internal data class GenerationPointer(val current: String, val previous: String?) {
    init {
        requireDirectory(validName(current) && (previous == null || validName(previous)))
    }

    fun bytes(): ByteArray =
        JSONObject()
            .put("format", FORMAT)
            .put("current", current)
            .put("previous", previous ?: JSONObject.NULL)
            .toString()
            .toByteArray()

    companion object {
        private const val FORMAT = 1
        private const val MAXIMUM_POINTER_BYTES = 1024
        private val namePattern = Regex("[a-f0-9]{64}-[a-f0-9]{64}(-[a-f0-9-]{36})?")

        private fun validName(name: String): Boolean = name.matches(namePattern)

        fun read(file: AtomicFile): GenerationPointer? =
            try {
                val text =
                    file.openRead().use {
                        it.readBounded(MAXIMUM_POINTER_BYTES).toString(Charsets.UTF_8)
                    }
                if (validName(text)) GenerationPointer(text, null)
                else {
                    val json = parseObject(text)
                    requireDirectory(json.count("format", FORMAT.toLong()) == FORMAT.toLong())
                    GenerationPointer(
                        json.getString("current"),
                        if (json.isNull("previous")) null else json.getString("previous"),
                    )
                }
            } catch (_: FileNotFoundException) {
                null
            }
    }
}
