-- Client-only sync bookkeeping, like _outbox: hand-written, not in the shared
-- schema. Holds the id of the server database this store last reconciled with
-- (key 'server_id'), so the sync client can detect when the database behind
-- the server URL has been replaced and its revs/cursor no longer mean
-- anything. See docs/SYNC.md.
CREATE TABLE IF NOT EXISTS `_sync_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
