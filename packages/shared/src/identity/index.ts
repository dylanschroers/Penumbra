// Stable identity: the names under which this app's data lives on disk.
//
// ┌─ READ THIS BEFORE CHANGING ANYTHING IN THIS FILE ─────────────────────┐
// │ None of these values is the product name, and that is deliberate.     │
// │ Changing any of them ORPHANS EXISTING USER DATA: the old records stay │
// │ on disk under the old name, invisible to the app, with no error. The  │
// │ build stays green. The tests stay green. The data is simply gone.     │
// │                                                                       │
// │ So: renaming the product must never reach this file. Display names    │
// │ (window title, <h1>, productName, docs, the agent's system prompt)    │
// │ are free to change at any time and live at their point of use.        │
// └───────────────────────────────────────────────────────────────────────┘
//
// Values are named for the ROLE they play, not for the product, because a
// role ("the local store") outlives a brand. If one of these ever genuinely
// must change, it needs a migration that reads the old name and writes the
// new one — not an edit here.

/** Prefix for every localStorage key. Keys compose as
 * `${STORAGE_NAMESPACE}.<feature>.<vN>`; the version suffix is per-key and
 * owned by the feature, so bumping one key never disturbs another. */
export const STORAGE_NAMESPACE = "app";

/** OPFS SAH pool name for the browser build's SQLite database. This is a
 * directory in the origin's private filesystem — renaming it strands the
 * database inside the old directory. */
export const LOCAL_DB_POOL = "local-store";

/** Database filename inside the OPFS pool (browser) and inside the platform
 * app-data directory (desktop). Kept identical across both so the two builds
 * describe their storage the same way. The desktop side repeats this literal
 * in Rust — see apps/desktop/src-tauri/src/db.rs. */
export const LOCAL_DB_FILE = "local.db";

/** Default path for the server's SQLite file, overridable via `DB_PATH`.
 * Lower stakes than the above — it is a default, not baked identity, and an
 * operator who set DB_PATH is unaffected — but it is still a live database. */
export const SERVER_DB_FILE = "server.db";

// ── Not expressible here, but governed by the same rule ──────────────────
//
// The Tauri bundle identifier (`identifier` in apps/desktop/src-tauri/
// tauri.conf.json) is the strictest case of all. The OS keys install/upgrade,
// code signing, and `app_data_dir()` off it, so changing it does not upgrade
// the installed app — it installs a second one alongside, with an empty data
// directory. It must never track `productName`, which is the display name and
// free to change.
//
// It lives in JSON (no comments) and is read by Rust (can't import this file),
// so it cannot be defined here. This note is the record.
//
// ⚠ RELEASE BLOCKER — the current value is a placeholder.
//
//   identifier = "local.placeholder.assistant"
//
// It is deliberately not a real reverse-DNS namespace: it claims no domain and
// names no person. It MUST be replaced before the first build that anyone else
// installs, because the value is only freely changeable until it has created
// data directories on someone else's machine. After that, changing it strands
// their data exactly as described above.
//
// Replacement should be a namespace the *project* owns, not an individual:
//   com.<project>.desktop            — if the project has a domain
//   io.github.<project-org>.desktop  — a GitHub org (free, verifiable)
// Pick it when the project's name is settled. Do not let the placeholder ship.
