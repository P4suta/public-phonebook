package page.dial.data

import java.io.ByteArrayInputStream
import java.io.IOException
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class TransportBoundaryTest {
    @get:Rule val temporary = TemporaryFolder()
    private val complete = "verified archive".toByteArray()
    private val hash by lazy {
        FileDigest.sha256(temporary.newFile().apply { writeBytes(complete) })
    }

    @Test
    fun networkRestrictionDuringReadRetainsTheExactResumePrefix() {
        val partial = temporary.newFile()
        var permitted = true
        val input =
            object : ByteArrayInputStream(complete) {
                override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                    val count = super.read(buffer, offset, minOf(length, 4))
                    permitted = false
                    return count
                }
            }
        val connection = FakeConnection(200, input)
        assertThrows(IOException::class.java) {
            DatasetTransport(DatasetTransport.ORIGIN, { permitted }) { connection }
                .download("/api/archive", complete.size.toLong(), hash, partial)
        }
        assertTrue(connection.disconnected)
        assertArrayEquals(complete.take(4).toByteArray(), partial.readBytes())
        val resumed =
            FakeConnection(
                206,
                ByteArrayInputStream(complete.drop(4).toByteArray()),
                mapOf("Content-Range" to "bytes 4-15/16"),
            )
        DatasetTransport(DatasetTransport.ORIGIN, { true }) { resumed }
            .download("/api/archive", complete.size.toLong(), hash, partial)
        assertArrayEquals(complete, partial.readBytes())
    }

    @Test
    fun cachedVerifiedBytesNeedNoConnectionAndInvalidOriginsCannotOpenOne() {
        val cached = temporary.newFile().apply { writeBytes(complete) }
        DatasetTransport(DatasetTransport.ORIGIN, { false }) { error("Unexpected network request") }
            .download("/api/archive", complete.size.toLong(), hash, cached)
        for (origin in
            listOf("http://www.dial.page", "https://example.test", "https://www.dial.page/")) {
            assertThrows(IllegalArgumentException::class.java) {
                DatasetTransport(origin, { true })
            }
        }
        for (path in
            listOf(
                "//example.test/api/archive",
                "https://example.test/api/archive",
                "/api/../outside",
                "/api/archive#fragment",
            )) {
            assertThrows(IOException::class.java) {
                DatasetTransport(DatasetTransport.ORIGIN, { true }) {
                        error("Unexpected network request")
                    }
                    .json(path)
            }
        }
    }

    @Test
    fun unexpectedStatusEncodingAndRangeNeverOverwriteASavedPrefix() {
        val invalid =
            listOf(
                FakeConnection(302, ByteArrayInputStream(complete)),
                FakeConnection(500, ByteArrayInputStream(complete)),
                FakeConnection(206, ByteArrayInputStream(complete.drop(4).toByteArray())),
                FakeConnection(
                    206,
                    ByteArrayInputStream(complete.drop(4).toByteArray()),
                    mapOf("Content-Range" to "bytes 5-15/16"),
                ),
                FakeConnection(
                    200,
                    ByteArrayInputStream(complete),
                    mapOf("Content-Encoding" to "gzip"),
                ),
            )
        for (connection in invalid) {
            val partial = temporary.newFile().apply { writeBytes(complete.take(4).toByteArray()) }
            assertThrows(IOException::class.java) {
                DatasetTransport(DatasetTransport.ORIGIN, { true }) { connection }
                    .download("/api/archive", complete.size.toLong(), hash, partial)
            }
            assertArrayEquals(complete.take(4).toByteArray(), partial.readBytes())
            assertTrue(connection.disconnected)
        }
    }

    @Test
    fun shortResponsesAndThreadInterruptionRemainResumable() {
        val partial = temporary.newFile()
        val connection = FakeConnection(200, ByteArrayInputStream(complete.take(4).toByteArray()))
        assertThrows(IOException::class.java) {
            DatasetTransport(DatasetTransport.ORIGIN, { true }) { connection }
                .download("/api/archive", complete.size.toLong(), hash, partial)
        }
        assertEquals(4L, partial.length())
        assertTrue(connection.disconnected)
        var opened = false
        try {
            Thread.currentThread().interrupt()
            assertThrows(java.io.InterruptedIOException::class.java) {
                DatasetTransport(DatasetTransport.ORIGIN, { true }) {
                        opened = true
                        connection
                    }
                    .download("/api/archive", complete.size.toLong(), hash, partial)
            }
        } finally {
            Thread.interrupted()
        }
        assertFalse(opened)
        assertEquals(4L, partial.length())
    }
}
