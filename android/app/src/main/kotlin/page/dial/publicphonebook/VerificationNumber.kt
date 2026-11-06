package page.dial.publicphonebook

import android.content.Context
import android.util.AtomicFile
import java.io.File
import page.dial.core.CanonicalPhone

object VerificationNumber {
    private fun file(context: Context) =
        AtomicFile(File(context.noBackupFilesDir, "verification-number"))

    fun matches(context: Context, number: CanonicalPhone): Boolean {
        if (!BuildConfig.QA_ENABLED) return false
        return try {
            file(context).openRead().bufferedReader().use { it.readText() == number.value }
        } catch (_: java.io.FileNotFoundException) {
            false
        }
    }

    fun save(context: Context, number: CanonicalPhone) {
        check(BuildConfig.QA_ENABLED)
        val destination = file(context)
        val output = destination.startWrite()
        try {
            output.write(number.value.toByteArray())
            destination.finishWrite(output)
        } catch (failure: java.io.IOException) {
            destination.failWrite(output)
            throw failure
        }
    }

    fun clear(context: Context) {
        file(context).delete()
    }
}
