package page.dial.data

import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import page.dial.core.DirectoryLimits

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class JsonDocumentTest {
    @Test
    fun strictObjectsRejectAmbiguousSyntaxAndExcessiveNesting() {
        val invalid =
            listOf(
                "{} trailing",
                "{} {}",
                "{unquoted:1}",
                "{\"name\":1,\"name\":2}",
                "{/* comment */\"name\":1}",
                "{\"nested\":" +
                    "[".repeat(DirectoryLimits.MAXIMUM_JSON_DEPTH) +
                    "0" +
                    "]".repeat(DirectoryLimits.MAXIMUM_JSON_DEPTH) +
                    "}",
            )
        invalid.forEach { text -> assertThrows(IOException::class.java) { parseObject(text) } }
        assertEquals(1, parseObject("{\"name\":1}").getInt("name"))
        assertThrows(IOException::class.java) { parseObject("{\"name\":1}").text("name") }
        assertThrows(IOException::class.java) {
            byteArrayOf(123, 34, -1, 34, 58, 48, 125).inputStream().readObject()
        }
    }
}
