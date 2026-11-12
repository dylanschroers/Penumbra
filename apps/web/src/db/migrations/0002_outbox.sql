-- Client-only, hand-written: the server has no outbox, so it's not in the
-- shared schema. See docs/SYNC.md.
CREATE TABLE IF NOT EXISTS `_outbox` (
	`seq` integer PRIMARY KEY AUTOINCREMENT,
	`row_id` text NOT NULL
);
