// Native SQLite for desktop. The webview's DbApi sends each statement here over
// IPC (apps/web/src/db/tauriExec.ts); rows return as arrays of column values,
// matching the sqlite-wasm path.

use rusqlite::types::ValueRef;
use rusqlite::Connection;
use serde_json::Value;
use std::sync::Mutex;
use tauri::Manager;

/// A Mutex suffices: the JS side already serializes statements.
pub struct Db(Mutex<Connection>);

/// Failure here fails startup: no silent fallback that could lose data.
pub fn open(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    // Mirrors LOCAL_DB_FILE in packages/shared/src/identity. Renaming orphans the
    // user's database.
    let path = dir.join("local.db");
    let conn = Connection::open(&path)?;
    app.manage(Db(Mutex::new(conn)));
    eprintln!("[penumbra] database: {}", path.display());
    Ok(())
}

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

/// Queries and mutations alike; non-SELECT statements yield no rows.
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
                ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
                ValueRef::Blob(b) => Value::String(String::from_utf8_lossy(b).into_owned()),
            });
        }
        out.push(vals);
    }
    Ok(out)
}
