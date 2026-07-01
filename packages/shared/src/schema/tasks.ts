import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// The local-store (SQLite) definition of the tasks table — Plane A, owned data.
// The Postgres counterpart for the server arrives in the sync phase and will
// live beside this one so the two dialects never drift.
//
// Timestamps are stored as ISO-8601 strings (text) rather than integers so a
// row reads the same in SQLite today and Postgres later, and matches the Zod
// `task` schema in ../validation/task.ts.
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
  // Sync columns (Plane A, see docs/SYNC.md).
  //   deletedAt — soft-delete tombstone so deletions propagate; null = live.
  //   rev       — server-assigned monotonic version. It is the pull cursor:
  //               a client asks for rows with rev greater than the highest it
  //               has seen. Null on a row created locally and not yet pushed.
  deletedAt: text("deleted_at"),
  rev: integer("rev"),
});

// Row shapes inferred directly from the table definition — the storage-side
// counterpart to the Zod-inferred types in ../validation/task.ts.
export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;
