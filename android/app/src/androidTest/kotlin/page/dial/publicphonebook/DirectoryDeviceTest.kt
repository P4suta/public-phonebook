package page.dial.publicphonebook

import android.os.Bundle
import android.os.Debug
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import page.dial.data.SearchForms

@RunWith(AndroidJUnit4::class)
class DirectoryDeviceTest {
    @Test
    fun bundledDirectoryPreparesAndSearchesOnDevice() = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val application = instrumentation.targetContext.applicationContext as PhonebookApplication
        val began = SystemClock.elapsedRealtime()
        val ready = application.directory.prepare()
        val preparation = SystemClock.elapsedRealtime() - began
        assertEquals(if (BuildConfig.FLAVOR == "development") 241L else 667696L, ready.contacts)
        val searched = SystemClock.elapsedRealtime()
        val results = application.directory.preview("図書館")
        val elapsed = SystemClock.elapsedRealtime() - searched
        assertTrue(results.groups.isNotEmpty())
        assertEquals(ready.snapshot, results.snapshot)
        for (group in results.groups) {
            assertEquals(minOf(3L, group.total).toInt(), group.contacts.size)
            val category = application.directory.search("図書館", group.category.id)
            assertEquals(group.total, category.total)
            assertEquals(group.contacts, category.contacts.take(3))
        }
        val found =
            application.directory.find(
                results.groups.first().contacts.first().phones.first().number
            )
        assertNotNull(found)
        verifySharedSearchContract()
        val memory = Debug.MemoryInfo().also(Debug::getMemoryInfo)
        instrumentation.sendStatus(
            2,
            Bundle().apply {
                putLong("preparationMs", preparation)
                putLong("searchMs", elapsed)
                putInt("totalPssKiB", memory.totalPss)
                putString("snapshot", ready.snapshot.value)
            },
        )
    }

    private fun verifySharedSearchContract() {
        val context = InstrumentationRegistry.getInstrumentation().context
        val contract =
            context.assets.open("SearchContract.json").bufferedReader().use {
                JSONObject(it.readText())
            }
        val forms = SearchForms.load()
        val words = contract.getJSONArray("words")
        assertTrue(words.length() > 0)
        for (index in 0 until words.length()) {
            val entry = words.getJSONObject(index)
            val expected = entry.getJSONArray("words")
            assertEquals(
                (0 until expected.length()).map { expected.getString(it) },
                forms.words(entry.getString("text")),
            )
        }
        val ranks = contract.getJSONArray("ranks")
        assertTrue(ranks.length() > 0)
        for (index in 0 until ranks.length()) {
            val entry = ranks.getJSONObject(index)
            val places = entry.getJSONArray("places")
            assertEquals(
                entry.getInt("rank"),
                forms.rank(
                    entry.getString("name"),
                    (0 until places.length()).map { places.getString(it) },
                    entry.getString("query"),
                ),
            )
        }
    }
}
