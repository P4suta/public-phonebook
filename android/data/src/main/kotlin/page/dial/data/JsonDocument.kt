package page.dial.data

import android.util.JsonReader
import android.util.JsonToken
import java.io.InputStream
import java.io.StringReader
import java.nio.ByteBuffer
import org.json.JSONObject
import page.dial.core.DirectoryLimits
import page.dial.core.JsonPolicy

internal fun InputStream.readObject(): JSONObject =
    parseObject(
        Charsets.UTF_8.newDecoder()
            .decode(ByteBuffer.wrap(readBounded(DirectoryLimits.MAXIMUM_JSON_BYTES)))
            .toString(),
    )

internal fun parseObject(text: String): JSONObject {
    JsonReader(StringReader(text)).use { reader ->
        reader.isLenient = false
        requireDirectory(reader.peek() == JsonToken.BEGIN_OBJECT)
        reader.validateValue(0)
        requireDirectory(reader.peek() == JsonToken.END_DOCUMENT)
    }
    return JSONObject(text)
}

private fun JsonReader.validateValue(depth: Int) {
    checkInterruption()
    requireDirectory(JsonPolicy.validDepth(depth))
    when (peek()) {
        JsonToken.BEGIN_OBJECT -> {
            beginObject()
            val names = hashSetOf<String>()
            while (hasNext()) {
                requireDirectory(names.add(nextName()))
                validateValue(depth + 1)
            }
            endObject()
        }
        JsonToken.BEGIN_ARRAY -> {
            beginArray()
            while (hasNext()) validateValue(depth + 1)
            endArray()
        }
        JsonToken.STRING,
        JsonToken.NUMBER -> nextString()
        JsonToken.BOOLEAN -> nextBoolean()
        JsonToken.NULL -> nextNull()
        else -> throw InvalidDirectory("Unexpected JSON token")
    }
}
