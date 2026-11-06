package page.dial.publicphonebook

import android.app.Application
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit
import page.dial.data.DeviceDirectory

class PhonebookApplication : Application() {
    val directory: DeviceDirectory by lazy {
        DeviceDirectory(this, BuildConfig.ORIGIN, BuildConfig.SYNC_ENABLED)
    }

    fun scheduleUpdates() {
        if (!BuildConfig.SYNC_ENABLED) return
        val manager = WorkManager.getInstance(this)
        val check =
            PeriodicWorkRequestBuilder<DirectoryCheckWorker>(24, TimeUnit.HOURS)
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
                )
                .build()
        manager.enqueueUniquePeriodicWork("directory-check", ExistingPeriodicWorkPolicy.KEEP, check)
        enqueueTransfer()
    }

    fun enqueueTransfer() {
        val transfer =
            OneTimeWorkRequestBuilder<DirectoryTransferWorker>()
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.UNMETERED)
                        .setRequiresStorageNotLow(true)
                        .build()
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
        WorkManager.getInstance(this)
            .enqueueUniqueWork("directory-transfer", ExistingWorkPolicy.KEEP, transfer)
    }
}

class DirectoryCheckWorker(context: android.content.Context, parameters: WorkerParameters) :
    CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result =
        try {
            val app = applicationContext as PhonebookApplication
            app.directory.prepare()
            app.directory.refresh()
            app.enqueueTransfer()
            Result.success()
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            Result.retry()
        }
}

class DirectoryTransferWorker(context: android.content.Context, parameters: WorkerParameters) :
    CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result =
        try {
            val app = applicationContext as PhonebookApplication
            if (!app.directory.transferPermitted()) Result.retry()
            else {
                app.directory.prepare()
                app.directory.refresh()
                Result.success()
            }
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            Result.retry()
        }
}
