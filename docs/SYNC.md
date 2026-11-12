# Penumbra: Sync engine (Plane A)

How owned data (today: tasks) reconciles across devices. Read before touching
`apps/web/src/sync`, `apps/server/src/sync`, or the sync columns in
`packages/shared`. A custom pull/push over REST, chosen over PowerSync or
ElectricSQL because one user with last-write-wins does not justify an extra
service.

## The model

Every owned row carries two sync columns (`packages/shared/src/schema/tasks.ts`):

- **`deletedAt`**: soft-delete tombstone, so deletes propagate.
- **`rev`**: server-assigned, monotonically increasing; the pull cursor. `null`
  until the server accepts the row. Clients never invent one.

The server is the merge authority.

## A sync round

`SyncClient.ts` runs **push, then pull**:

1. **Push**: drain the client-only `_outbox` table and `POST /sync/tasks` with
   the full rows. On `2xx`, clear only the outbox seqs that were sent, so a
   mutation that landed mid-push survives to the next round.
2. **Pull**: `GET /sync/tasks?since=<MAX(rev)>` and apply with LWW. Pushing
   first means the pull returns the server `rev` for rows just pushed.

Triggers: startup, every 15s, the `online` event, and 800ms after a local edit.
Only the tab that owns the store runs it.

## Server-side writes

The Tier 1 agent writes to the server's database while the user looks at the
client's, so both directions need a nudge:

- **Pre-turn flush**: the client pushes pending edits before a turn starts.
- **Post-tool pull**: `RemoteEngine` calls `requestSync()` on every tool event.
  Without it, a created task shows up 15 seconds after the answer.

### The rev trap

`pull` selects `WHERE rev > ?`, and revs are assigned only in `applyPush`. A
server write that inserts directly leaves `rev` NULL and the row is invisible to
every client forever, with no error. Every server write goes through
`TaskSyncStore.push()` (`apps/server/src/store/tasks.ts`).

Also: `pull` returns tombstones, so `list_tasks` must filter to live rows; and
the server stamps the same `"local"` `userId` the client does until auth exists.

## Conflict resolution: last-write-wins

Per row, by `updatedAt` (ISO-8601). Client (`upsertFromServer`) and server
(`applyPush`) keep the stored row only if it is **strictly newer**; ties go to
the incoming write. A delete is an `updatedAt` bump plus `deletedAt`, so
delete-vs-edit races follow the same rule. Clock skew can change which edit wins
a close race but never drops one, because the cursor is `rev`, not time.

## Epochs

If the server database is replaced behind the same URL, the client's cursor may
be past anything the new database will issue (deaf client), and rows acked by
the old database are never re-offered (stranded rows).

So the server mints an `instance_id` in its `meta` table when the database is
created (`apps/server/src/sync/store.ts`) and returns it as `serverId` on every
response. The client keeps the last one in `_sync_meta`. On an unfamiliar id,
including first sync, `adoptServer` nulls every local `rev`, re-enqueues every
row including tombstones, stores the id, and runs another push+pull. A restored
backup keeps its id. Caveat: deletions made after a device's last sync died with
the old database, so that device re-seeds those rows.

## Limitations

- **No auth** on `/sync/*`. Before it faces the internet, add per-device tokens
  or the Identity module.
- **Single user.** Rows carry `userId` but nothing scopes requests yet.
- **Tasks only.** Another table adopts sync by adding the two columns and an
  endpoint pair.
