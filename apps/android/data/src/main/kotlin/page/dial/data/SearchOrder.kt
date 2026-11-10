package page.dial.data

import android.database.sqlite.SQLiteDatabase
import android.os.CancellationSignal
import java.text.Normalizer
import java.util.Locale

internal object SearchOrder {
    const val SCHEMA_VERSION = 1

    fun key(name: String): String =
        Normalizer.normalize(name, Normalizer.Form.NFKC).lowercase(Locale.ROOT).trim()

    fun migrate(db: SQLiteDatabase, cancellation: CancellationSignal? = null) {
        if (db.version == SCHEMA_VERSION) return
        requireDirectory(db.version == 0)
        DatabaseTransaction(db).use { transaction ->
            db.execSQL("ALTER TABLE contacts ADD COLUMN sort_name TEXT NOT NULL DEFAULT ''")
            db.compileStatement("UPDATE contacts SET sort_name=? WHERE id=?").use { update ->
                db.rawQuery("SELECT id,raw FROM contacts ORDER BY id", null).use { rows ->
                    while (rows.moveToNext()) {
                        checkInterruption()
                        cancellation?.throwIfCanceled()
                        val name = ArchiveFields.parse(rows.getString(1))[ArchiveColumn.Name]
                        update.bindString(1, key(name))
                        update.bindLong(2, rows.getLong(0))
                        update.executeUpdateDelete()
                    }
                }
            }
            db.version = SCHEMA_VERSION
            transaction.commit()
        }
    }
}
