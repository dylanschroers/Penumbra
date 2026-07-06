# Ghost — Sync engine (Plane A)

How owned, local-first data (today: tasks) reconciles across a user's devices.
This is the design the code references throughout; read it before touching
anything under `apps/web/src/sync`, `apps/server/src/sync`, or the sync columns
in `packages/shared`.

## Why a custom delta-sync, not PowerSync / ElectricSQL

ARCHITECTURE.md names PowerSync or ElectricSQL but treats the engine as
"swappable, behind the data layer." Both options mean running an extra sync
service, and PowerSync would replace the working OPFS + Drizzle client store with
its own SDK. For **one user, their own devices, last-write-wins**, that is far
more than the problem needs. So v0 is a small pull/push delta-sync that rides the
existing REST server and existing client SQLite store. Swapping in a heavier
engine later stays contained to the `sync/` modules.

## The model

Every owned row carries two sync columns (see
`packages/shared/src/schema/tasks.ts`):

- **`deletedAt`** — soft-delete tombstone. `null` = live. A deleted row stays in
  the table (filtered out of `listTasks`) so the deletion itself can propagate.
- **`rev`** — a server-assigned, monotonically increasing integer. It is the
  **pull cursor**: a client asks for every row with `rev` greater than the
  highest it has stored. `null` on a row created locally and not yet accepted by
  the server.

The server is the single **merge authority**. It owns `rev` and resolves
conflicts. Clients never invent a `rev`.

## A sync round

`apps/web/src/sync/SyncClient.ts` runs one round as **push, then pull**:

1. **Push** — drain the client-only `_outbox` table (every local mutation appends
   the touched row id there) and `POST /sync/tasks` with those full rows. On a
   `2xx`, clear exactly the outbox seqs that were collected — a mutation that
   landed mid-push has a higher seq and survives to the next round, so no edit is
   lost.
2. **Pull** — `GET /sync/tasks?since=<cursor>` where `cursor = MAX(rev)` the
   client has stored. Apply returned rows locally with the same LWW rule. Pushing
   first means the round's pull also brings back the server `rev` for the rows
   just pushed, so local rows pick up their authoritative version.

Triggers: on startup, on a 15s interval, on the `online` event, and debounced
(~800ms) right after a local edit. Only the tab that owns the local store runs
the loop — the single-tab guard guarantees that's the one rendering the app.

## Conflict resolution: last-write-wins

Per row, by `updatedAt` (ISO-8601 strings, which sort chronologically). On both
client (`upsertFromServer`) and server (`applyPush`):

> keep the stored row only when it is **strictly newer** than the incoming one;
> otherwise the incoming edit wins, ties included.

Ties go to the incoming write so the server, as merge authority, stays
deterministic. A delete is just an `updatedAt` bump plus a `deletedAt` stamp, so
delete-vs-edit races resolve by the same rule (newest wins, and a newer edit can
revive a row).

### Clock skew

`updatedAt` is wall-clock, so skew between devices only ever changes *which* edit
wins a close race — acceptable for a single user. It can **never drop a change**,
because the pull cursor is the server's `rev` sequence, not a timestamp.

## Epochs: surviving a replaced server database

Revs are only meaningful relative to the database that issued them. If the
server's database is replaced behind the same URL (deleted and recreated, moved
to a new machine, a different server on the same port), two client invariants
break silently:

1. **Cursor monotonicity** — the client's cursor may be higher than the new
   database will reach for a while, so pulls return nothing (deaf client).
2. **Push durability** — the outbox is cleared on ack, but the acknowledged
   copy died with the old database, so those rows are never offered again
   (stranded rows).

So the server mints a random `instance_id` when its database is created (`meta`
table, `apps/server/src/db.ts`) and returns it as `serverId` on every response.
A restored backup keeps its id — its revs are still valid. The client stores
the last adopted id in the client-only `_sync_meta` table; when a pull returns
an unfamiliar one (including the first sync ever), it **reconciles**
(`adoptServer` in the DB worker): null every local `rev` (which also resets the
pull cursor to 0), re-enqueue every row — tombstones included — into the
outbox, store the new id, then run one more push+pull. LWW makes the full
re-exchange converge, whatever order devices reconnect in.

Cost in the steady state: one string field per response. Caveat: a device that
last synced before the old database died re-seeds everything it still has,
including rows whose deletion happened after its last sync — the tombstones
died with the old database. Inherent to losing server history; LWW keeps it
deterministic.

## Endpoints

`apps/server/src/sync/tasks.ts`:

- `GET /sync/tasks?since=N` → `{ rows, cursor, serverId }` — rows with `rev > N`
  in `rev` order; `cursor` is the new high-water mark.
- `POST /sync/tasks` body `{ rows }` → `{ cursor, serverId }` — validates
  against the shared `pushTasksInput` schema, then LWW-upserts in one
  transaction, assigning each accepted write the next `rev`.

The wire shape is `syncTask` in `packages/shared/src/validation/sync.ts` — a full
stored row, so its optional columns (`notes`, `dueAt`) are **nullable**, matching
what SQLite returns, not just `.optional()`.

## Storage

- **Client:** browser SQLite (OPFS SAHPool) in the DB worker. Migrations
  `0001_*` add the sync columns; `0002_outbox.sql` adds the client-only `_outbox`
  (deliberately not in the shared schema — the server has no outbox);
  `0003_sync_meta.sql` adds the client-only `_sync_meta` (last adopted
  `serverId`, see Epochs above).
- **Server:** `better-sqlite3`, one file (`DB_PATH`, default `ghost-server.db`,
  gitignored). One table, driven by the raw driver; the shared Zod schema governs
  the wire format so the two stores cannot drift. Moving to Postgres later is
  contained to `apps/server/src/db.ts`.

## v0 limitations (read before exposing this beyond localhost/LAN)

- **No auth.** The sync endpoints trust anyone who can reach them, and CORS
  reflects any origin. Fine for `localhost` or a trusted LAN. Before this ever
  faces the open internet, add a bearer token (cheap) or the Identity module
  (device registration + per-device sync state, per ARCHITECTURE.md).
- **Single user.** Every row carries `userId` (`"local"`), but nothing scopes
  requests to a caller yet. Multi-user is a query-scoping change, not a schema
  one.
- **Tasks only.** Other Plane A tables adopt sync by adding the same two columns
  and a matching endpoint pair.
