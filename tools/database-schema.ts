export const databaseSchema = `
CREATE TABLE contacts (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  prefecture TEXT NOT NULL,
  municipality TEXT,
  category TEXT NOT NULL,
  source_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE INDEX contact_name ON contacts(normalized_name, id);
CREATE INDEX contact_region ON contacts(prefecture, municipality, category, normalized_name, id);
CREATE INDEX contact_category ON contacts(category, normalized_name, id);
CREATE TABLE phones (number TEXT NOT NULL, contact_rowid INTEGER NOT NULL REFERENCES contacts(rowid), PRIMARY KEY(number, contact_rowid)) WITHOUT ROWID;
CREATE TABLE sources (id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload))) WITHOUT ROWID;
CREATE TABLE metadata (key TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload))) WITHOUT ROWID;
CREATE VIRTUAL TABLE contact_search USING fts5(terms, content='', detail=none);
CREATE VIRTUAL TABLE search_vocabulary USING fts5vocab(contact_search, 'row');
`;
