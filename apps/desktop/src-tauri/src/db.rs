// Native SQLite storage for the desktop build. The webview's DbApi sends every
// SQL statement here over IPC (apps/web/src/db/tauriExec.ts); rows go back as
// arrays of column values, the same shape the browser's sqlite-wasm path
// produces, so the TypeScript layer above is identical on both platforms.
//
// This replaces in-webview persistence (OPFS) on desktop entirely: the database
// is an ordinary file in the app data dir, owned by this process, immune to
// webview storage quirks.

use rusqlite::types::ValueRef;
use rusqlite::Connection;
use serde_json::Value;
use std::sync::Mutex;
use tauri::Manager;

/// The app's single connection. A Mutex is enough: the JS side already
/// serializes statements (tauriExec's promise chain), so this only guards
/// against Tauri running commands on multiple threads.
pub struct Db(Mutex<Connection>);

/// Open (or create) the database file and hand it to Tauri's managed state.
/// Called once from setup; failing here should fail app startup — a desktop
/// app that cannot persist is broken, and silent fallbacks hide data loss.
pub fn open(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    // Mirrors LOCAL_DB_FILE in packages/shared/src/identity — stable storage
    // identity, deliberately not the product name. Renaming this orphans the
    // user's database silently. Rust can't import the TS constant, so the two
    // literals are kept in sync by hand; see that file before touching this.
    let path = dir.join("local.db");
    let conn = Connection::open(&path)?;
    app.manage(Db(Mutex::new(conn)));
    eprintln!("[ghost] database: {}", path.display());
    Ok(())
}

/// JSON param -> SQLite value. The JS layer only binds strings, numbers, and
/// nulls today; booleans and anything exotic get a sane encoding anyway.
fn bind_value(v: &Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as Sql;
    match v {
        Value::Null => Sql::Null,
        Value::Bool(b) => Sql::Integer(*b as i64),
        Value::Number(n) => n
            .as_i64()
            .map(Sql::Integer)
            .unwrap_or_else(|| Sql::Real(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => Sql::Text(s.clone()),
        other => Sql::Text(other.to_string()),
    }
}

/// Run one SQL statement and return its rows as arrays of column values.
/// Works for queries and mutations alike (SQLite executes on the first step;
/// non-SELECT statements simply yield no rows).
#[tauri::command]
pub fn db_exec(
    state: tauri::State<'_, Db>,
    sql: String,
    params: Vec<Value>,
) -> Result<Vec<Vec<Value>>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let cols = stmt.column_count();
    let mut rows = stmt
        .query(rusqlite::params_from_iter(params.iter().map(bind_value)))
        .map_err(|e| e.to_string())?;

    let mut out: Vec<Vec<Value>> = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let mut vals = Vec::with_capacity(cols);
        for i in 0..cols {
            let v = row.get_ref(i).map_err(|e| e.to_string())?;
            vals.push(match v {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) => Value::from(n),
                ValueRef::Real(f) => Value::from(f),
                ValueRef::Text(t) => {
                    Value::String(String::from_utf8_lossy(t).into_owned())
                }
                // No blob columns in the schema; decode leniently if one appears.
                ValueRef::Blob(b) => {
                    Value::String(String::from_utf8_lossy(b).into_owned())
                }
            });
        }
        out.push(vals);
    }
    Ok(out)
}
