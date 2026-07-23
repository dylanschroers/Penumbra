// Native filesystem access for the desktop file-manager sidebar. The webview
// calls fs_list over IPC (apps/web/src/fs/fsClient.ts); the reply is a plain
// JSON value, the same hand-built shape db.rs uses for rows, so no serde derive
// is needed. Read-only by design: this lists a directory, it never mutates disk.

use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::UNIX_EPOCH;
use tauri::Manager;

/// List one directory. An empty `path` means "start at the user's home dir".
/// Returns `{ path, parent, entries[] }`: the canonical absolute path, its
/// parent (null at a filesystem root, so the UI can disable "up"), and the
/// entries — each carrying name/path/isDir plus best-effort size and modified
/// time (millis since the epoch). Entries we can't stat (permissions, races)
/// are skipped rather than failing the whole listing.
#[tauri::command]
pub fn fs_list(app: tauri::AppHandle, path: String) -> Result<Value, String> {
    let dir = if path.is_empty() {
        app.path().home_dir().map_err(|e| e.to_string())?
    } else {
        PathBuf::from(&path)
    };
    // Canonicalize so symlinks and `..` collapse to a real path and the parent
    // link is well-defined. Also surfaces a clear error for a bad path.
    let dir = dir.canonicalize().map_err(|e| e.to_string())?;

    let mut entries: Vec<Value> = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        let Ok(meta) = entry.metadata() else { continue };
        let is_dir = meta.is_dir();
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);
        entries.push(json!({
            "name": entry.file_name().to_string_lossy(),
            "path": entry.path().to_string_lossy(),
            "isDir": is_dir,
            // Size is meaningless for a directory; leave it null there.
            "size": if is_dir { Value::Null } else { json!(meta.len()) },
            "modified": modified,
        }));
    }

    Ok(json!({
        "path": dir.to_string_lossy(),
        "parent": dir.parent().map(|p| p.to_string_lossy().into_owned()),
        "entries": entries,
    }))
}

/// Move a file or directory into `to_dir`, keeping its name. Returns the new
/// path. This is the sidebar's only write op for now — enough to reorganize
/// files, nothing destructive beyond the move itself.
///
/// Guards, because a move can silently eat data otherwise:
///   - never overwrite an existing entry at the destination;
///   - never move a directory into itself or one of its own descendants.
/// Uses `std::fs::rename`, so a move across filesystems/drives fails with the
/// OS error rather than being silently copied — a copy+delete fallback can come
/// later if it's actually needed.
#[tauri::command]
pub fn fs_move(from: String, to_dir: String) -> Result<Value, String> {
    let from = PathBuf::from(&from)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let to_dir = PathBuf::from(&to_dir)
        .canonicalize()
        .map_err(|e| e.to_string())?;

    if !to_dir.is_dir() {
        return Err("destination is not a folder".into());
    }
    let name = from
        .file_name()
        .ok_or_else(|| "source has no name".to_string())?;
    let dest = to_dir.join(name);

    if dest == from {
        // Already there — nothing to do.
        return Ok(json!({ "path": from.to_string_lossy() }));
    }
    if dest.exists() {
        return Err(format!("already exists: {}", dest.display()));
    }
    // `to_dir` sitting under `from` means we'd be moving a folder into itself.
    if from.is_dir() && to_dir.starts_with(&from) {
        return Err("cannot move a folder into itself".into());
    }

    std::fs::rename(&from, &dest).map_err(|e| e.to_string())?;
    Ok(json!({ "path": dest.to_string_lossy() }))
}
