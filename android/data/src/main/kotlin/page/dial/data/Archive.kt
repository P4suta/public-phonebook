package page.dial.data

import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.Locale
import org.json.JSONObject
import page.dial.core.CanonicalPhone
import page.dial.core.Category
import page.dial.core.Contact
import page.dial.core.DirectoryLimits
import page.dial.core.Phone
import page.dial.core.TransferPolicy

internal const val ARCHIVE_SIGNATURE = "public-phonebook-directory\t1"
internal const val DELTA_SIGNATURE = "public-phonebook-directory-delta\t1"
private val dictionaryIndexPattern = Regex("0|[1-9][0-9]{0,8}")
private val regionPattern = Regex("[0-9]{2}|[0-9]{5}")
private val municipalityPattern = Regex("[0-9]{5}")
private val nationalPhonePattern = Regex("0[1-9][0-9]{8,9}")

internal enum class ArchiveColumn {
    Category,
    Region,
    Name,
    Address,
    Phones,
    Website,
    Provenance,
    Origin,
    Confirmation,
}

internal class ArchiveFields private constructor(private val values: List<String>) {
    operator fun get(column: ArchiveColumn): String = values[column.ordinal]

    fun remap(categories: List<Int?>, provenances: List<Int?>, links: List<Int?>): String {
        fun mapped(value: String, mapping: List<Int?>): String =
            (mapping[dictionaryIndex(value, mapping.size)]
                    ?: throw InvalidDirectory("Unmapped dictionary entry"))
                .toString()
        val fields = values.toMutableList()
        fields[ArchiveColumn.Category.ordinal] = mapped(this[ArchiveColumn.Category], categories)
        fields[ArchiveColumn.Provenance.ordinal] =
            mapped(this[ArchiveColumn.Provenance], provenances)
        fields[ArchiveColumn.Origin.ordinal] =
            this[ArchiveColumn.Origin].split('\u001f').joinToString("\u001f") { mapped(it, links) }
        val confirmation = this[ArchiveColumn.Confirmation]
        if (confirmation.isNotEmpty() && confirmation != "*")
            fields[ArchiveColumn.Confirmation.ordinal] = mapped(confirmation, links)
        return fields.joinToString("\t")
    }

    companion object {
        fun parse(line: String): ArchiveFields {
            val fields = line.split('\t')
            requireDirectory(fields.size == ArchiveColumn.entries.size)
            return ArchiveFields(fields)
        }
    }
}

internal fun dictionaryIndex(value: String, size: Int): Int {
    requireDirectory(value.matches(dictionaryIndexPattern))
    return value.toInt().also { requireDirectory(it in 0 until size) }
}

internal class Lines(private val input: InputStream) : Closeable {
    private val buffer = ByteArray(DirectoryLimits.BUFFER_BYTES)
    private var available = 0
    private var position = 0
    private var total = 0L
    val consumed: Long
        get() = total

    fun next(maximum: Int = DirectoryLimits.MAXIMUM_LINE_BYTES): String? {
        val line = ByteArrayOutputStream()
        while (true) {
            if (position == available) {
                available = input.read(buffer)
                position = 0
                if (available < 0) {
                    requireDirectory(line.size() == 0)
                    return null
                }
            }
            val start = position
            while (position < available && buffer[position] != '\n'.code.toByte()) position++
            val count = position - start
            requireDirectory(
                TransferPolicy.chunk(line.size().toLong(), count.toLong(), maximum.toLong()) &&
                    TransferPolicy.chunk(
                        total,
                        count.toLong(),
                        DirectoryLimits.MAXIMUM_DECODED_BYTES,
                    )
            )
            line.write(buffer, start, count)
            total += count
            if (position < available) {
                requireDirectory(
                    TransferPolicy.chunk(total, 1, DirectoryLimits.MAXIMUM_DECODED_BYTES)
                )
                position++
                total++
                return decode(line.toByteArray())
            }
        }
    }

    private fun decode(bytes: ByteArray): String {
        requireDirectory(bytes.none { it == '\r'.code.toByte() || it == 0.toByte() })
        return Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
            .toString()
    }

    override fun close() = input.close()
}

internal class ArchiveHeader(val json: JSONObject) {
    val snapshot = digest(json.getString("snapshot"))
    val contacts = json.count("contacts")
    val categories = json.getJSONArray("categories").objects()
    val prefectures = json.getJSONArray("prefectures").objects()
    val municipalities = json.getJSONArray("municipalities").objects()
    val sources = json.getJSONArray("sources").objects()
    val provenances = json.getJSONArray("provenances").objects()
    val links =
        json.getJSONArray("links").let { array ->
            (0 until array.length()).map { publicUrl(array.getString(it)) }
        }
    val regions: Map<String, Pair<String, String>>

    init {
        json.text("generatedAt", DirectoryLimits.MAXIMUM_TIMESTAMP_BYTES)
        requireDirectory(
            categories.size in 1..DirectoryLimits.MAXIMUM_CATEGORY_COUNT &&
                categories
                    .map { it.text("id", DirectoryLimits.MAXIMUM_IDENTIFIER_BYTES) }
                    .distinct()
                    .size == categories.size
        )
        categories.forEach {
            it.text("label")
            it.text("publisher")
            it.text("license")
            publicUrl(it.getString("licenseUrl"))
        }
        requireDirectory(
            prefectures.map { it.getString("code") } ==
                (1..DirectoryLimits.PREFECTURE_COUNT).map { String.format(Locale.ROOT, "%02d", it) }
        )
        prefectures.forEach {
            it.text("name")
            it.count("contacts")
        }
        requireDirectory(prefectures.sumOf { it.getLong("contacts") } == contacts)
        regions = regionNames()
        requireDirectory(
            sources.size <= DirectoryLimits.MAXIMUM_SOURCES &&
                provenances.size <= DirectoryLimits.MAXIMUM_PROVENANCES &&
                links.size <= DirectoryLimits.MAXIMUM_LINKS
        )
        sources.forEach {
            it.text("id", DirectoryLimits.MAXIMUM_IDENTIFIER_BYTES)
            publicUrl(it.getString("url"))
            if (it.has("publisher")) it.text("publisher")
            if (it.has("title")) it.text("title")
        }
        provenances.forEach {
            it.count("source", (sources.size - 1).toLong())
            it.text("license", DirectoryLimits.MAXIMUM_LICENSE_BYTES)
            publicUrl(it.getString("licenseUrl"))
            it.text("dataAsOf", DirectoryLimits.MAXIMUM_TIMESTAMP_BYTES, true)
            it.text("retrievedAt", DirectoryLimits.MAXIMUM_TIMESTAMP_BYTES)
        }
    }

    private fun regionNames(): Map<String, Pair<String, String>> {
        requireDirectory(
            municipalities.size <= DirectoryLimits.MAXIMUM_MUNICIPALITIES &&
                municipalities.map { it.getString("code") }.distinct().size == municipalities.size
        )
        val names =
            prefectures
                .associate { it.getString("code") to (it.getString("name") to "") }
                .toMutableMap()
        municipalities.forEach {
            val code = it.getString("code")
            val prefecture = it.getString("prefectureCode")
            requireDirectory(
                code.matches(municipalityPattern) &&
                    code.startsWith(prefecture) &&
                    names.containsKey(prefecture)
            )
            names[code] = names.getValue(prefecture).first to it.text("name")
        }
        return names
    }

    fun record(line: String, row: Long): Contact {
        val fields = ArchiveFields.parse(line)
        validateText(fields)
        validateLinks(fields)
        val category = categories[dictionaryIndex(fields[ArchiveColumn.Category], categories.size)]
        val code = fields[ArchiveColumn.Region]
        requireDirectory(code.matches(regionPattern))
        val region =
            regions[code] ?: regions[code.take(2)] ?: throw InvalidDirectory("Unknown region")
        val provenance =
            provenances[dictionaryIndex(fields[ArchiveColumn.Provenance], provenances.size)]
        val source = sources[provenance.getInt("source")]
        return Contact(
            snapshot,
            row,
            Category(category.getString("id"), category.getString("label")),
            region.first,
            region.second,
            fields[ArchiveColumn.Name],
            fields[ArchiveColumn.Address],
            phones(fields[ArchiveColumn.Phones]),
            fields[ArchiveColumn.Website].takeIf { it.isNotEmpty() }?.let(::publicUrl),
            source.getString("url"),
            source.optString("publisher", category.getString("publisher")),
            provenance.getString("license"),
            provenance.getString("licenseUrl"),
            provenance.getString("retrievedAt"),
        )
    }

    private fun validateText(fields: ArchiveFields) {
        val name = fields[ArchiveColumn.Name]
        val address = fields[ArchiveColumn.Address]
        requireDirectory(
            name.isNotEmpty() &&
                name.toByteArray().size <= DirectoryLimits.MAXIMUM_NAME_BYTES &&
                address.toByteArray().size <= DirectoryLimits.MAXIMUM_ADDRESS_BYTES
        )
        requireDirectory(
            name.none { it == '\u001e' || it == '\u001f' } &&
                address.none { it == '\u001e' || it == '\u001f' }
        )
    }

    private fun validateLinks(fields: ArchiveFields) {
        val origins = fields[ArchiveColumn.Origin].split('\u001f')
        requireDirectory(origins.size in 1..DirectoryLimits.MAXIMUM_ORIGIN_LINKS)
        origins.forEach { dictionaryIndex(it, links.size) }
        val confirmation = fields[ArchiveColumn.Confirmation]
        if (confirmation.isNotEmpty() && confirmation != "*")
            dictionaryIndex(confirmation, links.size)
    }

    private fun phones(field: String): List<Phone> {
        val phones = field.split('\u001f').map(::phone)
        requireDirectory(
            phones.size in 1..DirectoryLimits.MAXIMUM_PHONES &&
                phones.map { it.number }.distinct().size == phones.size
        )
        return phones
    }

    private fun phone(entry: String): Phone {
        val parts = entry.split('\u001e')
        requireDirectory(parts.size in 1..2)
        val national = if (parts.size == 2) parts[0] else parts[0].filter { it in '0'..'9' }
        requireDirectory(
            national.matches(nationalPhonePattern) &&
                parts.last().isNotEmpty() &&
                parts.last().toByteArray().size <= DirectoryLimits.MAXIMUM_PHONE_DISPLAY_BYTES
        )
        return Phone(
            CanonicalPhone.parse(national) ?: throw InvalidDirectory("Invalid phone"),
            parts.last(),
        )
    }
}
