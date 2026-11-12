-- Client-only, hand-written. Holds the last reconciled server database id
-- (key 'server_id'). See docs/SYNC.md → Epochs.
CREATE TABLE IF NOT EXISTS `_sync_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
