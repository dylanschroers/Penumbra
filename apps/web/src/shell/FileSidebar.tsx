import { type DragEvent, useRef, useState } from "react";
import type { DirEntry } from "../fs/fsClient";
import { type FileTree, useFileTree } from "../fs/useFileTree";
import {
  ChevronIcon,
  CloseIcon,
  FileIcon,
  FolderIcon,
  PlusIcon,
} from "./fileIcons";

// The left rail: a read/write file browser over the real OS filesystem (desktop
// only). The user imports one or more root folders via the native picker; each
// becomes its own collapsible section, and everything beneath it is reachable.
// Nothing is open by default — a fresh sidebar is just the "Add folder" button.
// Entries can be dragged onto a folder to move them (write access, via fs_move).
//
// The web build has no Tauri, so it renders a short placeholder instead.

/** Last path segment — a folder/file's own display name. */
function baseName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Folders first, then case-insensitive by name. */
function sortEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

const INDENT = 12; // px per tree level

// Drag-and-drop plumbing shared by every row. `draggingRef` holds the path being
// dragged (a ref so a drag doesn't re-render the tree); `overPath` drives the
// drop-target highlight.
interface Drag {
  overPath: string | null;
  onDragStart: (path: string) => (e: DragEvent) => void;
  onDragOverFolder: (folder: string) => (e: DragEvent) => void;
  onDragLeaveFolder: (folder: string) => (e: DragEvent) => void;
  onDropFolder: (folder: string) => (e: DragEvent) => void;
}

function DirRow({
  entry,
  depth,
  tree,
  drag,
}: {
  entry: DirEntry;
  depth: number;
  tree: FileTree;
  drag: Drag;
}) {
  const open = tree.expanded.has(entry.path);
  return (
    <li>
      <button
        type="button"
        className={`file-row file-row--dir${drag.overPath === entry.path ? " file-row--drop" : ""}`}
        style={{ paddingLeft: depth * INDENT + 6 }}
        onClick={() => tree.toggle(entry.path)}
        title={entry.name}
        draggable
        onDragStart={drag.onDragStart(entry.path)}
        onDragOver={drag.onDragOverFolder(entry.path)}
        onDragLeave={drag.onDragLeaveFolder(entry.path)}
        onDrop={drag.onDropFolder(entry.path)}
      >
        <ChevronIcon
          className={`file-row__chevron${open ? " file-row__chevron--open" : ""}`}
        />
        <FolderIcon className="file-row__icon" />
        <span className="file-row__name">{entry.name}</span>
      </button>
      {open && (
        <TreeChildren
          path={entry.path}
          depth={depth + 1}
          tree={tree}
          drag={drag}
        />
      )}
    </li>
  );
}

function FileRow({
  entry,
  depth,
  drag,
}: {
  entry: DirEntry;
  depth: number;
  drag: Drag;
}) {
  return (
    <li
      className="file-row file-row--file"
      style={{ paddingLeft: depth * INDENT + 6 }}
      title={entry.name}
      draggable
      onDragStart={drag.onDragStart(entry.path)}
    >
      {/* Spacer aligns files with the chevron column of sibling folders. */}
      <span className="file-row__chevron file-row__chevron--spacer" />
      <FileIcon className="file-row__icon" />
      <span className="file-row__name">{entry.name}</span>
    </li>
  );
}

/** The children of one directory: loading / error / empty, else the rows. */
function TreeChildren({
  path,
  depth,
  tree,
  drag,
}: {
  path: string;
  depth: number;
  tree: FileTree;
  drag: Drag;
}) {
  const entries = tree.children[path];
  const error = tree.errors[path];
  const isLoading = tree.loading.has(path);
  const pad = { paddingLeft: depth * INDENT + 6 };

  if (error)
    return (
      <p className="file-sidebar__note file-sidebar__note--error" style={pad}>
        {error}
      </p>
    );
  if (!entries)
    return isLoading ? (
      <p className="file-sidebar__note" style={pad}>
        Loading…
      </p>
    ) : null;
  if (entries.length === 0)
    return (
      <p className="file-sidebar__note" style={pad}>
        Empty
      </p>
    );

  return (
    <ul className="file-list">
      {sortEntries(entries).map((entry) =>
        entry.isDir ? (
          <DirRow
            key={entry.path}
            entry={entry}
            depth={depth}
            tree={tree}
            drag={drag}
          />
        ) : (
          <FileRow key={entry.path} entry={entry} depth={depth} drag={drag} />
        ),
      )}
    </ul>
  );
}

function RootSection({
  root,
  tree,
  drag,
}: {
  root: string;
  tree: FileTree;
  drag: Drag;
}) {
  const open = tree.expanded.has(root);
  return (
    <li className="file-root">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drag-and-drop
          drop zone has no interactive ARIA role; the controls inside are real
          buttons and carry the keyboard/screen-reader semantics. */}
      <div
        className={`file-row file-root__head${drag.overPath === root ? " file-row--drop" : ""}`}
        onDragOver={drag.onDragOverFolder(root)}
        onDragLeave={drag.onDragLeaveFolder(root)}
        onDrop={drag.onDropFolder(root)}
      >
        <button
          type="button"
          className="file-root__toggle"
          onClick={() => tree.toggle(root)}
          title={root}
        >
          <ChevronIcon
            className={`file-row__chevron${open ? " file-row__chevron--open" : ""}`}
          />
          <FolderIcon className="file-row__icon" />
          <span className="file-row__name">{baseName(root)}</span>
        </button>
        <button
          type="button"
          className="file-root__remove"
          onClick={() => tree.removeRoot(root)}
          aria-label={`Remove ${baseName(root)}`}
          title="Remove folder"
        >
          <CloseIcon />
        </button>
      </div>
      {open && <TreeChildren path={root} depth={1} tree={tree} drag={drag} />}
    </li>
  );
}

export function FileSidebar({
  collapsed,
  onCollapsedChange,
}: {
  // Collapsed state is owned by the shell so the logo's minimize gesture can
  // close the rail (and restore it) alongside the rest of the workspace; the
  // header buttons here just drive the same setter.
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  const tree = useFileTree();
  const draggingRef = useRef<string | null>(null);
  const [overPath, setOverPath] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const drag: Drag = {
    overPath,
    onDragStart: (path) => (e) => {
      draggingRef.current = path;
      e.dataTransfer.setData("text/plain", path);
      e.dataTransfer.effectAllowed = "move";
      setNotice(null);
    },
    onDragOverFolder: (folder) => (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (overPath !== folder) setOverPath(folder);
    },
    onDragLeaveFolder: (folder) => () => {
      if (overPath === folder) setOverPath(null);
    },
    onDropFolder: (folder) => (e) => {
      e.preventDefault();
      const from = draggingRef.current ?? e.dataTransfer.getData("text/plain");
      draggingRef.current = null;
      setOverPath(null);
      if (from && from !== folder) {
        tree.move(from, folder).catch((err) => setNotice(String(err)));
      }
    },
  };

  if (!tree.available) {
    return (
      <aside className="file-sidebar file-sidebar--empty">
        <div className="file-sidebar__head">
          <span className="file-sidebar__title">Files</span>
        </div>
        <p className="file-sidebar__note">
          The file browser is available in the desktop app.
        </p>
      </aside>
    );
  }

  if (collapsed) {
    return (
      <aside className="file-sidebar file-sidebar--collapsed">
        <button
          type="button"
          className="file-sidebar__iconbtn"
          onClick={() => onCollapsedChange(false)}
          aria-label="Show files"
          title="Show files"
        >
          <FolderIcon />
        </button>
      </aside>
    );
  }

  return (
    <aside className="file-sidebar">
      <div className="file-sidebar__head">
        <span className="file-sidebar__title">Files</span>
        <button
          type="button"
          className="file-sidebar__iconbtn"
          onClick={() => tree.addRoot()}
          aria-label="Add folder"
          title="Add folder"
        >
          <PlusIcon />
        </button>
        <button
          type="button"
          className="file-sidebar__iconbtn"
          onClick={() => onCollapsedChange(true)}
          aria-label="Hide files"
          title="Hide files"
        >
          <ChevronIcon className="file-sidebar__chevron-left" />
        </button>
      </div>

      <div className="file-sidebar__body">
        {notice && (
          <p className="file-sidebar__note file-sidebar__note--error">
            {notice}
          </p>
        )}
        {tree.roots.length === 0 ? (
          <p className="file-sidebar__note">
            No folders yet — use ＋ to add one.
          </p>
        ) : (
          <ul className="file-list">
            {tree.roots.map((root) => (
              <RootSection key={root} root={root} tree={tree} drag={drag} />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
