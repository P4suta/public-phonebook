#include <sqlite3.h>

static inline sqlite3_destructor_type phonebook_sqlite_transient(void) {
    return SQLITE_TRANSIENT;
}
