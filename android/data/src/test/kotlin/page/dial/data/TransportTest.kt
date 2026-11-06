package page.dial.data

import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Files
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class TransportTest {
    private val complete = "verified archive".toByteArray()
    private val root = Files.createTempDirectory("phonebook-transport").toFile()
    private val source = File(root, "source").apply { writeBytes(complete) }
    private val hash = FileDigest.sha256(source)

    @Test
    fun interruptedTransferResumesWithExactRangeAndIdentity() {
        val partial = File(root, "download.part")
        val interrupted =
            FakeConnection(
                200,
                object : InputStream() {
                    private var read = false

                    override fun read(): Int = throw IOException("stopped")

                    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                        if (read) throw IOException("stopped")
                        read = true
                        complete.copyInto(buffer, offset, 0, 4)
                        return 4
                    }
                },
            )
        val transport = DatasetTransport(DatasetTransport.ORIGIN, { true }) { interrupted }
        assertThrows(IOException::class.java) {
            transport.download("/api/archive", complete.size.toLong(), hash, partial)
        }
        assertEquals(4L, partial.length())
        assertTrue(interrupted.disconnected)
        val resumed =
            FakeConnection(
                206,
                ByteArrayInputStream(complete.drop(4).toByteArray()),
                mapOf("Content-Range" to "bytes 4-${complete.size - 1}/${complete.size}"),
            )
        DatasetTransport(DatasetTransport.ORIGIN, { true }) { resumed }
            .download("/api/archive", complete.size.toLong(), hash, partial)
        assertEquals("bytes=4-", resumed.getRequestProperty("Range"))
        assertEquals("identity", resumed.getRequestProperty("Accept-Encoding"))
        assertFalse(resumed.instanceFollowRedirects)
        assertArrayEquals(complete, partial.readBytes())
    }

    @Test
    fun ignoredRangeRestartsAndWrongRangeRetainsPreviousBytes() {
        val file = File(root, "restart.part").apply { writeBytes(complete.take(4).toByteArray()) }
        val wrong =
            FakeConnection(
                206,
                ByteArrayInputStream(complete),
                mapOf("Content-Range" to "bytes 0-1/2"),
            )
        assertThrows(InvalidDirectory::class.java) {
            DatasetTransport(DatasetTransport.ORIGIN, { true }) { wrong }
                .download("/api/archive", complete.size.toLong(), hash, file)
        }
        assertEquals(4L, file.length())
        val restart = FakeConnection(200, ByteArrayInputStream(complete))
        DatasetTransport(DatasetTransport.ORIGIN, { true }) { restart }
            .download("/api/archive", complete.size.toLong(), hash, file)
        assertArrayEquals(complete, file.readBytes())
    }

    @Test
    fun corruptOversizedAndRestrictedTransfersCannotPublish() {
        val file = File(root, "bad.part")
        val corrupt = FakeConnection(200, ByteArrayInputStream(ByteArray(complete.size)))
        assertThrows(InvalidDirectory::class.java) {
            DatasetTransport(DatasetTransport.ORIGIN, { true }) { corrupt }
                .download("/api/archive", complete.size.toLong(), hash, file)
        }
        assertFalse(file.exists())
        val excessive = FakeConnection(200, ByteArrayInputStream(complete + byteArrayOf(1)))
        assertThrows(InvalidDirectory::class.java) {
            DatasetTransport(DatasetTransport.ORIGIN, { true }) { excessive }
                .download("/api/archive", complete.size.toLong(), hash, file)
        }
        var opened = false
        assertThrows(IOException::class.java) {
            DatasetTransport(DatasetTransport.ORIGIN, { false }) {
                    opened = true
                    excessive
                }
                .download("/api/archive", complete.size.toLong(), hash, file)
        }
        assertFalse(opened)
    }

    @Test
    fun listingUsesConditionalRequestsAndRejectsRedirectsAndInvalidUtf8() {
        val notModified = FakeConnection(304, ByteArrayInputStream(byteArrayOf()))
        val reply =
            DatasetTransport(DatasetTransport.ORIGIN, { true }) { notModified }
                .json("/api/datasets", "saved")
        assertNull(reply.body)
        assertEquals("saved", reply.etag)
        assertEquals("saved", notModified.getRequestProperty("If-None-Match"))
        for (connection in
            listOf(
                FakeConnection(302, ByteArrayInputStream(byteArrayOf())),
                FakeConnection(
                    200,
                    ByteArrayInputStream(byteArrayOf(0xc0.toByte(), 0xaf.toByte())),
                ),
            )) {
            assertThrows(IOException::class.java) {
                DatasetTransport(DatasetTransport.ORIGIN, { true }) { connection }
                    .json("/api/datasets")
            }
            assertTrue(connection.disconnected)
        }
    }
}

internal class FakeConnection(
    private val code: Int,
    private val input: InputStream,
    private val headers: Map<String, String> = emptyMap(),
) : HttpURLConnection(URL("https://www.dial.page/api/test")) {
    var disconnected = false

    override fun getResponseCode(): Int = code

    override fun getInputStream(): InputStream = input

    override fun getHeaderField(name: String): String? = headers[name]

    override fun getContentLengthLong(): Long = -1

    override fun getContentEncoding(): String? = headers["Content-Encoding"]

    override fun usingProxy(): Boolean = false

    override fun connect() = Unit

    override fun disconnect() {
        disconnected = true
    }
}
