package page.dial.data

import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.io.RandomAccessFile
import java.security.DigestInputStream
import java.security.MessageDigest
import java.util.BitSet
import org.brotli.dec.BrotliInputStream
import org.json.JSONObject
import page.dial.core.DirectoryLimits
import page.dial.core.SnapshotId
import page.dial.core.TransferPolicy

internal object DirectoryDelta {
    fun rebuild(
        base: File,
        delta: File,
        output: File,
        target: ArchiveEntry,
        decoded: DecodedIdentity? = null,
    ): RebuiltArchive =
        BrotliInputStream(delta.inputStream()).use { input ->
            rebuildDecoded(base, input, output, target, decoded)
        }

    fun rebuildDecoded(
        base: File,
        input: InputStream,
        output: File,
        target: ArchiveEntry,
        decoded: DecodedIdentity? = null,
    ): RebuiltArchive {
        val indexed = IndexedArchive(base)
        val hash = MessageDigest.getInstance("SHA-256")
        return Lines(DigestInputStream(input, hash)).use { lines ->
            requireDirectory(lines.next() == DELTA_SIGNATURE)
            val metadata =
                parseObject(
                    lines.next(DirectoryLimits.MAXIMUM_JSON_BYTES)
                        ?: throw InvalidDirectory("Missing delta header")
                )
            val targetText =
                lines.next(DirectoryLimits.MAXIMUM_JSON_BYTES)
                    ?: throw InvalidDirectory("Missing target header")
            val header = ArchiveHeader(parseObject(targetText))
            val contract = DeltaContract(metadata, indexed.header, header, base, target)
            RandomAccessFile(base, "r").use { source ->
                DeltaRows(contract, indexed, source, output).use { rows ->
                    rows.header(targetText)
                    while (true) {
                        checkInterruption()
                        val instruction = lines.next() ?: break
                        rows.instruction(instruction)
                    }
                    rows.finish()
                }
            }
            requireDirectory(
                output.length() == contract.bytes && FileDigest.sha256(output) == contract.hash
            )
            decoded?.let {
                requireDirectory(lines.consumed == it.bytes)
                requireDirectory(
                    digest(
                        hash.digest().joinToString("") { byte ->
                            "%02x".format(java.util.Locale.ROOT, byte)
                        }
                    ) == it.sha256
                )
            }
            RebuiltArchive(output, target, contract.bytes, contract.hash)
        }
    }
}

internal data class DecodedIdentity(val bytes: Long, val sha256: SnapshotId)

private class IndexedArchive(base: File) {
    val header: ArchiveHeader
    val offsets: LongArray

    init {
        Lines(base.inputStream()).use { lines ->
            requireDirectory(lines.next() == ARCHIVE_SIGNATURE)
            val text =
                lines.next(DirectoryLimits.MAXIMUM_JSON_BYTES)
                    ?: throw InvalidDirectory("Missing base header")
            header = ArchiveHeader(parseObject(text))
            offsets = LongArray(header.contacts.toInt() + 1)
            var count = 0
            offsets[0] = lines.consumed
            while (lines.next() != null) {
                requireDirectory(count < header.contacts)
                count++
                offsets[count] = lines.consumed
            }
            requireDirectory(count.toLong() == header.contacts)
        }
    }
}

private class DeltaContract(
    json: JSONObject,
    base: ArchiveHeader,
    val target: ArchiveHeader,
    file: File,
    entry: ArchiveEntry,
) {
    private val destination = json.getJSONObject("target")
    val kept = json.count("kept")
    val added = json.count("added")
    val bytes = destination.count("bytes", DirectoryLimits.MAXIMUM_DECODED_BYTES)
    val hash = digest(destination.getString("sha256"))
    val categories = mapping(json, "categories", base.categories.size, target.categories.size)
    val provenances = mapping(json, "provenances", base.provenances.size, target.provenances.size)
    val links = mapping(json, "links", base.links.size, target.links.size)

    init {
        val source = json.getJSONObject("base")
        requireDirectory(
            digest(source.getString("snapshot")) == base.snapshot &&
                source.count("contacts") == base.contacts &&
                source.count("bytes", DirectoryLimits.MAXIMUM_DECODED_BYTES) == file.length() &&
                digest(source.getString("sha256")) == FileDigest.sha256(file) &&
                digest(destination.getString("snapshot")) == entry.snapshot &&
                digest(destination.getString("archiveSha256")) == entry.sha256 &&
                destination.count("contacts") == entry.contacts &&
                base.snapshot != entry.snapshot &&
                kept + json.count("removed") == base.contacts &&
                kept + added == entry.contacts &&
                target.snapshot == entry.snapshot &&
                target.contacts == entry.contacts
        )
    }

    private fun mapping(json: JSONObject, key: String, from: Int, to: Int): List<Int?> {
        val array = json.getJSONArray(key)
        requireDirectory(array.length() == from)
        return (0 until array.length()).map { index ->
            if (array.isNull(index)) null
            else {
                val value = array.get(index)
                requireDirectory(value is Number)
                dictionaryIndex(value.toString(), to)
            }
        }
    }
}

private class DeltaRows(
    private val contract: DeltaContract,
    private val base: IndexedArchive,
    private val input: RandomAccessFile,
    output: File,
) : java.io.Closeable {
    private val writer = FileOutputStream(output)
    private val copied = BitSet(base.offsets.size)
    private var copiedCount = 0L
    private var addedCount = 0L
    private var rows = 0L
    private var written = 0L
    private var previous: ByteArray? = null

    fun header(text: String) {
        write(ARCHIVE_SIGNATURE)
        write(text)
    }

    fun instruction(instruction: String) {
        if (instruction.startsWith("+\t")) {
            row(instruction.drop(2))
            addedCount++
        } else {
            val parts = instruction.split('\t')
            requireDirectory(parts.size == COPY_FIELD_COUNT && parts.first() == "=")
            val start = dictionaryIndex(parts[1], base.offsets.size).toLong()
            val countText = parts.last()
            requireDirectory(countText.matches(positiveInteger))
            val count = countText.toLong()
            requireDirectory(
                TransferPolicy.copy(start, count, base.header.contacts) &&
                    TransferPolicy.chunk(copiedCount, count, contract.kept)
            )
            for (index in start until start + count) copy(index.toInt())
        }
    }

    private fun copy(index: Int) {
        checkInterruption()
        requireDirectory(!copied[index])
        copied.set(index)
        input.seek(base.offsets[index])
        val bytes = ByteArray((base.offsets[index + 1] - base.offsets[index] - 1).toInt())
        input.readFully(bytes)
        row(
            ArchiveFields.parse(bytes.toString(Charsets.UTF_8))
                .remap(contract.categories, contract.provenances, contract.links)
        )
        copiedCount++
    }

    private fun row(text: String) {
        requireDirectory(rows < contract.target.contacts)
        contract.target.record(text, rows)
        val bytes = text.toByteArray()
        previous?.let { requireDirectory(compareBytes(it, bytes) <= 0) }
        previous = bytes
        write(text)
        rows++
    }

    private fun write(line: String) {
        val size = line.toByteArray().size.toLong() + 1
        requireDirectory(TransferPolicy.chunk(written, size, contract.bytes))
        writer.line(line)
        written += size
    }

    fun finish() {
        requireDirectory(
            copiedCount == contract.kept &&
                addedCount == contract.added &&
                rows == contract.target.contacts &&
                written == contract.bytes
        )
        writer.fd.sync()
    }

    override fun close() = writer.close()

    companion object {
        private const val COPY_FIELD_COUNT = 3
        private val positiveInteger = Regex("[1-9][0-9]{0,8}")
    }
}
