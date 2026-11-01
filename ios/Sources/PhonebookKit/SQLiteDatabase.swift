import CSQLite
import Foundation

enum DatabaseError: Error {
  case sqlite(Int32, String)
}

enum SQLValue {
  case text(String)
  case integer(Int64)
  case null
}

final class SQLiteDatabase {
  fileprivate var handle: OpaquePointer?

  init(url: URL, readOnly: Bool) throws {
    let flags = readOnly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE
    let status = sqlite3_open_v2(url.path, &handle, flags | SQLITE_OPEN_NOMUTEX, nil)
    guard status == SQLITE_OK else { throw failure(status) }
    sqlite3_busy_timeout(handle, 5_000)
  }

  deinit { sqlite3_close_v2(handle) }

  fileprivate func failure(_ code: Int32) -> DatabaseError {
    DatabaseError.sqlite(code, String(cString: sqlite3_errmsg(handle)))
  }

  func close() throws {
    guard handle != nil else { return }
    let result = sqlite3_close(handle)
    guard result == SQLITE_OK else { throw failure(result) }
    handle = nil
  }

  func prepare(_ sql: String) throws -> SQLiteStatement { try SQLiteStatement(self, sql) }

  func query<Value>(_ sql: String, _ values: [SQLValue] = [], row: (OpaquePointer) throws -> Value)
    throws -> [Value]
  {
    let statement = try prepare(sql)
    try statement.bind(values)
    var rows: [Value] = []
    while let current = try statement.step() { rows.append(try row(current)) }
    return rows
  }

  func execute(_ sql: String, _ values: [SQLValue] = []) throws {
    let _: [Int] = try query(sql, values) { _ in 0 }
  }

  static func text(_ row: OpaquePointer, _ column: Int32, maximumBytes: Int = 1_048_576) throws
    -> String
  {
    let count = Int(sqlite3_column_bytes(row, column))
    guard count >= 0, count <= maximumBytes else { throw ImportError.projectionTooLarge }
    guard let pointer = sqlite3_column_text(row, column),
      let value = String(bytes: UnsafeBufferPointer(start: pointer, count: count), encoding: .utf8)
    else { throw ImportError.invalidRecord }
    return value
  }

  static func optionalText(_ row: OpaquePointer, _ column: Int32) throws -> String? {
    sqlite3_column_type(row, column) == SQLITE_NULL ? nil : try text(row, column)
  }

  static func integer(_ row: OpaquePointer, _ column: Int32) -> Int64 {
    sqlite3_column_int64(row, column)
  }
}

final class SQLiteStatement {
  private let database: SQLiteDatabase
  private let handle: OpaquePointer

  fileprivate init(_ database: SQLiteDatabase, _ sql: String) throws {
    var statement: OpaquePointer?
    let result = sqlite3_prepare_v2(database.handle, sql, -1, &statement, nil)
    guard result == SQLITE_OK, let statement else { throw database.failure(result) }
    self.database = database
    handle = statement
  }

  deinit { sqlite3_finalize(handle) }

  func bind(_ values: [SQLValue]) throws {
    sqlite3_reset(handle)
    sqlite3_clear_bindings(handle)
    guard sqlite3_bind_parameter_count(handle) == values.count else {
      throw ImportError.invalidRecord
    }
    for (index, value) in values.enumerated() {
      let position = Int32(index + 1)
      let status: Int32
      switch value {
      case .text(let text):
        guard let count = Int32(exactly: text.utf8.count) else { throw ImportError.invalidRecord }
        status = sqlite3_bind_text(handle, position, text, count, phonebook_sqlite_transient())
      case .integer(let number):
        status = sqlite3_bind_int64(handle, position, number)
      case .null:
        status = sqlite3_bind_null(handle, position)
      }
      guard status == SQLITE_OK else { throw database.failure(status) }
    }
  }

  func step() throws -> OpaquePointer? {
    let step = sqlite3_step(handle)
    if step == SQLITE_DONE { return nil }
    guard step == SQLITE_ROW else { throw database.failure(step) }
    return handle
  }

  func run(_ values: [SQLValue]) throws {
    try bind(values)
    while try step() != nil {}
  }
}
