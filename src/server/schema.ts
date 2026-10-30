import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { Category } from "../core/catalog.ts";

export const contacts = sqliteTable(
  "contacts",
  {
    rowid: integer("rowid").primaryKey(),
    id: text("id").notNull(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    prefecture: text("prefecture").notNull(),
    municipality: text("municipality"),
    category: text("category").$type<Category>().notNull(),
    sourceId: text("source_id").notNull(),
    payload: text("payload").notNull(),
  },
  (table) => [
    uniqueIndex("contact_id").on(table.id),
    index("contact_name").on(table.normalizedName, table.id),
    index("contact_region").on(
      table.prefecture,
      table.municipality,
      table.category,
      table.normalizedName,
      table.id,
    ),
    index("contact_category").on(
      table.category,
      table.normalizedName,
      table.id,
    ),
  ],
);

export const phones = sqliteTable(
  "phones",
  {
    number: text("number").notNull(),
    contactRowid: integer("contact_rowid").notNull(),
  },
  (table) => [
    uniqueIndex("phone_contact").on(table.number, table.contactRowid),
  ],
);

export const sources = sqliteTable("sources", {
  id: text("id").primaryKey(),
  payload: text("payload").notNull(),
});
export const metadata = sqliteTable("metadata", {
  key: text("key").primaryKey(),
  payload: text("payload").notNull(),
});
