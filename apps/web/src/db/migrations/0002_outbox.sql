-- Client-only sync bookkeeping. NOT part of the shared Drizzle schema: the
-- server has no outbox, so this table is hand-written here rather than
-- generated. It records which task rows have local changes still waiting to be
-- pushed. The repository appends a row on every local mutation; the sync client
-- drains it after a successful push. See docs/SYNC.md.
CREATE TABLE IF NOT EXISTS `_outbox` (
	`seq` integer PRIMARY KEY AUTOINCREMENT,
	`row_id` text NOT NULL
);
