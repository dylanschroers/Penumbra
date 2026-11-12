// Filesystem access for the agent's file tools. Unlike src/fs.rs, every command
// here is confined to the folders shared in the sidebar: the caller passes those
// roots and each path is resolved natively (symlinks and `..` collapsed) before
// it is checked against them, so a model-chosen path cannot reach outside.

use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};

const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    ".venv",
    "venv",
    "__pycache__",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
];
const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES: u64 = 1024 * 1024;
const MAX_LIST_ENTRIES: usize = 1000;
const MAX_LIST_DEPTH: u32 = 4;
const MAX_LINE_CHARS: usize = 300;

fn canonical_roots(roots: &[String]) -> Result<Vec<PathBuf>, String> {
    let out: Vec<PathBuf> = roots
        .iter()
        .filter_map(|r| PathBuf::from(r).canonicalize().ok())
        .collect();
    if out.is_empty() {
        return Err("no shared folders: add a folder in the sidebar first".into());
    }
    Ok(out)
}

fn inside(roots: &[PathBuf], p: &Path) -> bool {
    roots.iter().any(|r| p.starts_with(r))
}

fn outside(path: &str) -> String {
    format!("{path} is outside the folders shared in the sidebar")
}

/// Turn a model-supplied path into an absolute one. A relative path is taken
/// against the only root, or against whichever root it already exists under.
fn absolutize(roots: &[PathBuf], path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path.trim());
    if p.as_os_str().is_empty() {
        return Err("path is empty".into());
    }
    if p.is_absolute() {
        return Ok(p);
    }
    if roots.len() == 1 {
        return Ok(roots[0].join(p));
    }
    let hits: Vec<PathBuf> = roots
        .iter()
        .map(|r| r.join(&p))
        .filter(|c| c.symlink_metadata().is_ok())
        .collect();
    match hits.len() {
        1 => Ok(hits[0].clone()),
        0 => Err(format!(
            "{path} is relative and several folders are shared; use an absolute path"
        )),
        _ => Err(format!(
            "{path} exists in more than one shared folder; use an absolute path"
        )),
    }
}

/// An existing path, resolved through symlinks, that must sit inside a root.
fn resolve_existing(roots: &[PathBuf], path: &str) -> Result<PathBuf, String> {
    let p = absolutize(roots, path)?;
    let c = p.canonicalize().map_err(|e| format!("{path}: {e}"))?;
    if !inside(roots, &c) {
        return Err(outside(path));
    }
    Ok(c)
}

/// A path that may not exist yet (a write or move target). Its nearest existing
/// ancestor is resolved and checked, then the missing components are appended.
fn resolve_target(roots: &[PathBuf], path: &str) -> Result<PathBuf, String> {
    let p = absolutize(roots, path)?;
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("{path}: `..` is not allowed in a write path"));
    }
    if p.exists() {
        let c = p.canonicalize().map_err(|e| format!("{path}: {e}"))?;
        return if inside(roots, &c) { Ok(c) } else { Err(outside(path)) };
    }
    // A dangling symlink would be followed by the write, wherever it points.
    if p.symlink_metadata().is_ok() {
        return Err(format!("{path} is a broken symlink"));
    }
    let mut missing = Vec::new();
    let mut base = p.as_path();
    while !base.exists() {
        missing.push(
            base.file_name()
                .ok_or_else(|| outside(path))?
                .to_os_string(),
        );
        base = base.parent().ok_or_else(|| outside(path))?;
    }
    let mut out = base.canonicalize().map_err(|e| format!("{path}: {e}"))?;
    if !inside(roots, &out) {
        return Err(outside(path));
    }
    for name in missing.iter().rev() {
        out.push(name);
    }
    Ok(out)
}

fn ignored(name: &str) -> bool {
    IGNORED_DIRS.contains(&name)
}

fn is_text(bytes: &[u8]) -> bool {
    !bytes[..bytes.len().min(8192)].contains(&0) && std::str::from_utf8(bytes).is_ok()
}

fn s(p: &Path) -> String {
    crate::fs::display_path(p)
}

/// With an empty `path`, the shared roots themselves. Otherwise the folder's
/// contents to `depth` levels, not descending into dependency or build folders.
#[tauri::command]
pub fn agent_fs_list(roots: Vec<String>, path: String, depth: u32) -> Result<Value, String> {
    let roots = canonical_roots(&roots)?;
    if path.trim().is_empty() {
        let entries: Vec<Value> = roots
            .iter()
            .map(|r| json!({ "path": s(r), "isDir": true, "size": null }))
            .collect();
        return Ok(json!({ "path": "", "entries": entries, "truncated": false }));
    }
    let dir = resolve_existing(&roots, &path)?;
    if !dir.is_dir() {
        return Err(format!("{path} is a file, not a folder"));
    }
    let mut entries = Vec::new();
    let mut truncated = false;
    list_into(&dir, depth.clamp(1, MAX_LIST_DEPTH), &mut entries, &mut truncated);
    Ok(json!({ "path": s(&dir), "entries": entries, "truncated": truncated }))
}

fn list_into(dir: &Path, depth: u32, out: &mut Vec<Value>, truncated: &mut bool) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    let mut items: Vec<(String, PathBuf, std::fs::Metadata)> = read
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            Some((e.file_name().to_string_lossy().into_owned(), e.path(), meta))
        })
        .collect();
    items.sort_by(|a, b| b.2.is_dir().cmp(&a.2.is_dir()).then(a.0.cmp(&b.0)));
    for (name, path, meta) in items {
        if out.len() >= MAX_LIST_ENTRIES {
            *truncated = true;
            return;
        }
        let is_dir = meta.is_dir();
        out.push(json!({
            "path": s(&path),
            "isDir": is_dir,
            "size": if is_dir { Value::Null } else { json!(meta.len()) },
        }));
        if is_dir && depth > 1 && !ignored(&name) {
            list_into(&path, depth - 1, out, truncated);
        }
    }
}

/// A text file's contents. `{ exists: false }` for a missing path so a writer
/// can tell "new file" from a failure.
#[tauri::command]
pub fn agent_fs_read(roots: Vec<String>, path: String) -> Result<Value, String> {
    let roots = canonical_roots(&roots)?;
    let target = resolve_target(&roots, &path)?;
    if !target.exists() {
        return Ok(json!({ "path": s(&target), "exists": false }));
    }
    let meta = std::fs::metadata(&target).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err(format!("{path} is a folder; use list_files"));
    }
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "{path} is {} bytes, over the {} byte limit for reading",
            meta.len(),
            MAX_READ_BYTES
        ));
    }
    let bytes = std::fs::read(&target).map_err(|e| e.to_string())?;
    if !is_text(&bytes) {
        return Err(format!("{path} is a binary or non-UTF-8 file"));
    }
    Ok(json!({
        "path": s(&target),
        "exists": true,
        "content": String::from_utf8(bytes).unwrap_or_default(),
    }))
}

/// Lines containing `query` (and files whose name contains it) under `path`, or
/// under every root when `path` is empty.
#[tauri::command]
pub fn agent_fs_search(
    roots: Vec<String>,
    query: String,
    path: String,
    case_sensitive: bool,
    max_results: usize,
) -> Result<Value, String> {
    let roots = canonical_roots(&roots)?;
    if query.is_empty() {
        return Err("query is empty".into());
    }
    let starts = if path.trim().is_empty() {
        roots.clone()
    } else {
        vec![resolve_existing(&roots, &path)?]
    };
    let needle = if case_sensitive { query.clone() } else { query.to_lowercase() };
    let fold = |t: &str| if case_sensitive { t.to_string() } else { t.to_lowercase() };
    let mut hits = Vec::new();
    let mut truncated = false;
    let mut stack = starts;
    while let Some(p) = stack.pop() {
        if hits.len() >= max_results {
            truncated = true;
            break;
        }
        let Ok(meta) = std::fs::metadata(&p) else { continue };
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if meta.is_dir() {
            if ignored(&name) {
                continue;
            }
            if let Ok(read) = std::fs::read_dir(&p) {
                let mut children: Vec<PathBuf> = read.filter_map(|e| e.ok()).map(|e| e.path()).collect();
                children.sort();
                children.reverse();
                stack.extend(children);
            }
            continue;
        }
        if fold(&name).contains(&needle) {
            hits.push(json!({ "path": s(&p), "line": null, "text": null }));
        }
        if meta.len() > MAX_SEARCH_FILE_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(&p) else { continue };
        if !is_text(&bytes) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        for (i, line) in text.lines().enumerate() {
            if fold(line).contains(&needle) {
                hits.push(json!({
                    "path": s(&p),
                    "line": i + 1,
                    "text": line.trim().chars().take(MAX_LINE_CHARS).collect::<String>(),
                }));
                if hits.len() >= max_results {
                    truncated = true;
                    break;
                }
            }
        }
    }
    Ok(json!({ "matches": hits, "truncated": truncated }))
}

/// Create or replace a text file, making missing parent folders. Written to a
/// temporary sibling and renamed over the target, so a failure never leaves a
/// half-written file; an existing file keeps its permissions.
#[tauri::command]
pub fn agent_fs_write(roots: Vec<String>, path: String, content: String) -> Result<Value, String> {
    let roots = canonical_roots(&roots)?;
    let target = resolve_target(&roots, &path)?;
    if target.is_dir() {
        return Err(format!("{path} is a folder"));
    }
    let existing = std::fs::metadata(&target).ok();
    let parent = target.parent().ok_or_else(|| outside(&path))?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let name = target.file_name().ok_or_else(|| outside(&path))?.to_string_lossy();
    let tmp = parent.join(format!(".{name}.penumbra-{}.tmp", std::process::id()));
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| e.to_string())?;
    if let Some(meta) = &existing {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(json!({ "path": s(&target), "created": existing.is_none(), "bytes": content.len() }))
}

#[tauri::command]
pub fn agent_fs_mkdir(roots: Vec<String>, path: String) -> Result<Value, String> {
    let roots = canonical_roots(&roots)?;
    let target = resolve_target(&roots, &path)?;
    if target.is_file() {
        return Err(format!("{path} is a file"));
    }
    let created = !target.exists();
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    Ok(json!({ "path": s(&target), "created": created }))
}

/// Move or rename. Never overwrites, never moves a folder into itself, and never
/// moves a shared root.
#[tauri::command]
pub fn agent_fs_move(roots: Vec<String>, from: String, to: String) -> Result<Value, String> {
    let roots = canonical_roots(&roots)?;
    let src = resolve_existing(&roots, &from)?;
    if roots.contains(&src) {
        return Err(format!("{from} is a shared folder itself and can't be moved"));
    }
    let dest = resolve_target(&roots, &to)?;
    if dest.exists() {
        return Err(format!("{to} already exists"));
    }
    if src.is_dir() && dest.starts_with(&src) {
        return Err("cannot move a folder into itself".into());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&src, &dest).map_err(|e| e.to_string())?;
    Ok(json!({ "from": s(&src), "path": s(&dest) }))
}

/// Move a file or folder to the OS trash, so a delete can be undone from there.
#[tauri::command]
pub fn agent_fs_delete(roots: Vec<String>, path: String) -> Result<Value, String> {
    let roots = canonical_roots(&roots)?;
    let target = resolve_existing(&roots, &path)?;
    if roots.contains(&target) {
        return Err(format!("{path} is a shared folder itself and can't be deleted"));
    }
    trash::delete(&target).map_err(|e| e.to_string())?;
    Ok(json!({ "path": s(&target) }))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    struct Sandbox {
        dir: PathBuf,
    }

    impl Sandbox {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "penumbra-agent-fs-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join("root/sub")).unwrap();
            std::fs::create_dir_all(dir.join("outside")).unwrap();
            std::fs::write(dir.join("root/a.txt"), "hello\nworld\n").unwrap();
            std::fs::write(dir.join("outside/secret.txt"), "secret").unwrap();
            Sandbox { dir }
        }
        fn root(&self) -> String {
            s(&self.dir.join("root"))
        }
        fn roots(&self) -> Vec<String> {
            vec![self.root()]
        }
        fn p(&self, rel: &str) -> String {
            s(&self.dir.join(rel))
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn reads_inside_and_refuses_outside() {
        let sb = Sandbox::new("read");
        let ok = agent_fs_read(sb.roots(), sb.p("root/a.txt")).unwrap();
        assert_eq!(ok["content"], "hello\nworld\n");
        assert!(agent_fs_read(sb.roots(), sb.p("outside/secret.txt")).is_err());
        assert!(agent_fs_read(sb.roots(), sb.p("root/../outside/secret.txt")).is_err());
    }

    #[test]
    fn a_symlink_out_of_the_root_does_not_escape() {
        let sb = Sandbox::new("symlink");
        symlink(sb.dir.join("outside"), sb.dir.join("root/link")).unwrap();
        assert!(agent_fs_read(sb.roots(), sb.p("root/link/secret.txt")).is_err());
        assert!(agent_fs_write(sb.roots(), sb.p("root/link/new.txt"), "x".into()).is_err());
        assert!(!sb.dir.join("outside/new.txt").exists());
    }

    #[test]
    fn a_dangling_symlink_is_not_written_through() {
        let sb = Sandbox::new("dangling");
        symlink(sb.dir.join("outside/nope.txt"), sb.dir.join("root/dangle")).unwrap();
        assert!(agent_fs_write(sb.roots(), sb.p("root/dangle"), "x".into()).is_err());
        assert!(!sb.dir.join("outside/nope.txt").exists());
    }

    #[test]
    fn writes_create_parents_and_report_new_files() {
        let sb = Sandbox::new("write");
        let out = agent_fs_write(sb.roots(), sb.p("root/new/deep/b.md"), "# hi".into()).unwrap();
        assert_eq!(out["created"], true);
        assert_eq!(std::fs::read_to_string(sb.dir.join("root/new/deep/b.md")).unwrap(), "# hi");
        let again = agent_fs_write(sb.roots(), sb.p("root/new/deep/b.md"), "# bye".into()).unwrap();
        assert_eq!(again["created"], false);
        assert!(agent_fs_write(sb.roots(), sb.p("root/../outside/x.txt"), "x".into()).is_err());
    }

    #[test]
    fn relative_paths_resolve_against_a_single_root() {
        let sb = Sandbox::new("relative");
        let out = agent_fs_read(sb.roots(), "a.txt".into()).unwrap();
        assert_eq!(out["content"], "hello\nworld\n");
    }

    #[test]
    fn binary_files_are_refused() {
        let sb = Sandbox::new("binary");
        std::fs::write(sb.dir.join("root/img.bin"), [0u8, 1, 2, 3]).unwrap();
        assert!(agent_fs_read(sb.roots(), sb.p("root/img.bin")).is_err());
    }

    #[test]
    fn missing_files_read_as_not_existing() {
        let sb = Sandbox::new("missing");
        let out = agent_fs_read(sb.roots(), sb.p("root/none.txt")).unwrap();
        assert_eq!(out["exists"], false);
    }

    #[test]
    fn search_finds_lines_and_names_and_skips_ignored_dirs() {
        let sb = Sandbox::new("search");
        std::fs::create_dir_all(sb.dir.join("root/node_modules")).unwrap();
        std::fs::write(sb.dir.join("root/node_modules/w.txt"), "world").unwrap();
        std::fs::write(sb.dir.join("root/sub/world.md"), "nothing here").unwrap();
        let out = agent_fs_search(sb.roots(), "WORLD".into(), "".into(), false, 50).unwrap();
        let hits: Vec<(String, Value)> = out["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| (m["path"].as_str().unwrap().to_string(), m["line"].clone()))
            .collect();
        assert!(hits.iter().any(|(p, l)| p.ends_with("a.txt") && *l == json!(2)));
        assert!(hits.iter().any(|(p, l)| p.ends_with("world.md") && l.is_null()));
        assert!(!hits.iter().any(|(p, _)| p.contains("node_modules")));
    }

    #[test]
    fn move_never_overwrites_or_moves_a_root() {
        let sb = Sandbox::new("move");
        std::fs::write(sb.dir.join("root/b.txt"), "b").unwrap();
        assert!(agent_fs_move(sb.roots(), sb.p("root/a.txt"), sb.p("root/b.txt")).is_err());
        assert!(agent_fs_move(sb.roots(), sb.root(), sb.p("root/sub/r")).is_err());
        assert!(agent_fs_move(sb.roots(), sb.p("root/a.txt"), sb.p("outside/a.txt")).is_err());
        let out = agent_fs_move(sb.roots(), sb.p("root/a.txt"), sb.p("root/sub/c.txt")).unwrap();
        assert!(out["path"].as_str().unwrap().ends_with("sub/c.txt"));
    }

    #[test]
    fn delete_refuses_roots_and_outside_paths() {
        let sb = Sandbox::new("delete");
        assert!(agent_fs_delete(sb.roots(), sb.root()).is_err());
        assert!(agent_fs_delete(sb.roots(), sb.p("outside/secret.txt")).is_err());
        assert!(sb.dir.join("outside/secret.txt").exists());
    }

    #[test]
    fn listing_skips_descending_into_ignored_dirs() {
        let sb = Sandbox::new("list");
        std::fs::create_dir_all(sb.dir.join("root/node_modules/pkg")).unwrap();
        let out = agent_fs_list(sb.roots(), sb.root(), 3).unwrap();
        let paths: Vec<String> = out["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["path"].as_str().unwrap().to_string())
            .collect();
        assert!(paths.iter().any(|p| p.ends_with("node_modules")));
        assert!(!paths.iter().any(|p| p.ends_with("pkg")));
        let top = agent_fs_list(sb.roots(), "".into(), 1).unwrap();
        assert_eq!(top["entries"].as_array().unwrap().len(), 1);
    }
}
