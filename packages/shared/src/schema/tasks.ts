import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Timestamps are ISO-8601 text so rows read the same in SQLite and Postgres.
export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  notes: text("notes"),
  priority: text("priority", { enum: ["low", "medium", "high"] })
    .notNull()
    .default("medium"),
  status: text("status", { enum: ["todo", "doing", "done"] })
    .notNull()
    .default("todo"),
  dueAt: text("due_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  // Sync columns (docs/SYNC.md). `rev` is the server-assigned pull cursor, null
  // until the server accepts the row.
  deletedAt: text("deleted_at"),
  rev: integer("rev"),
});

export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;
