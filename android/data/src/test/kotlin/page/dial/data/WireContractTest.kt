package page.dial.data

import java.io.IOException
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class WireContractTest {
    @Test
    fun wireCountsRequireAnIntegralJsonNumberInsideTheDeclaredRange() {
        for (value in listOf(-1, 1.5, "1", JSONObject.NULL, true, 11L)) {
            assertThrows(IOException::class.java) {
                JSONObject().put("count", value).count("count", 10)
            }
        }
        for (value in listOf(0L, 1L, 10L)) assertEquals(
            value,
            JSONObject().put("count", value).count("count", 10),
        )
        assertEquals(
            Long.MAX_VALUE,
            JSONObject().put("count", Long.MAX_VALUE).count("count", Long.MAX_VALUE),
        )
        assertThrows(IOException::class.java) { parseObject("{\"count\":1e3}").count("count") }
    }

    @Test
    fun boundedReadsAndTextMeasureBytesRatherThanCharacters() {
        assertArrayEquals(byteArrayOf(), byteArrayOf().inputStream().readBounded(0))
        assertArrayEquals(byteArrayOf(1, 2, 3), byteArrayOf(1, 2, 3).inputStream().readBounded(3))
        assertThrows(IOException::class.java) { byteArrayOf(1).inputStream().readBounded(0) }
        assertThrows(IOException::class.java) {
            byteArrayOf(1, 2, 3, 4).inputStream().readBounded(3)
        }
        assertEquals("あ", JSONObject().put("text", "あ").text("text", 3))
        assertThrows(IOException::class.java) { JSONObject().put("text", "あ").text("text", 2) }
        assertThrows(IOException::class.java) { JSONObject().put("text", "").text("text") }
        assertThrows(IOException::class.java) { JSONObject().put("text", 1).text("text") }
        assertEquals("", JSONObject().put("text", "").text("text", empty = true))
    }

    @Test
    fun servicePathsAndPublicUrlsEnforceTheirSeparateAuthorityContracts() {
        for (path in listOf("/api/datasets", "/api/dataset-deltas?snapshot=abc")) assertEquals(
            path,
            servicePath(path),
        )
        for (path in
            listOf(
                "/other",
                "//example.test/api/data",
                "https://example.test/api/data",
                "/api/../outside",
                "/api/data#fragment",
            )) {
            assertThrows(IOException::class.java) { servicePath(path) }
        }
        for (url in
            listOf(
                "https://example.test/path",
                "http://example.test/",
                "https://[::1]/",
            )) assertEquals(url, publicUrl(url))
        for (url in
            listOf(
                "ftp://example.test/",
                "https://user:secret@example.test/",
                "https://exa%00mple.test/",
                "https://example.test:65536/",
            )) {
            assertThrows(IOException::class.java) { publicUrl(url) }
        }
    }
}
