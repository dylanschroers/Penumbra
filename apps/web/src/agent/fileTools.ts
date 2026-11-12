import {
  type ClientTools,
  createFolderTool,
  deleteFileTool,
  editFileTool,
  fileTools,
  listFilesTool,
  moveFileTool,
  readFileTool,
  searchFilesTool,
  type ToolContract,
  writeFileTool,
} from "@penumbra/shared";
import { invoke } from "@tauri-apps/api/core";
import type { z } from "zod";
import { isFsAvailable } from "../fs/fsClient";
import { loadRoots, notifyFsChanged } from "../fs/roots";
import { requestApproval } from "./approvals";
import { lineDiff } from "./lineDiff";

// The file tools' desktop half: each shared contract bound to the scoped native
// commands in apps/desktop/src-tauri/src/agent_fs.rs. Reads run straight away;
// anything that changes disk waits for the user to approve it in the chat.

/** Cap on what one call feeds back to the model. */
const MAX_OUTPUT_CHARS = 60_000;
const SEARCH_LIMIT = 200;
export const DECLINED = "The user declined this change.";

interface Entry {
  path: string;
  isDir: boolean;
  size: number | null;
}
interface Listing {
  path: string;
  entries: Entry[];
  truncated: boolean;
}
interface ReadResult {
  path: string;
  exists: boolean;
  content?: string;
}
interface SearchResult {
  matches: { path: string; line: number | null; text: string | null }[];
  truncated: boolean;
}

interface Context {
  roots: string[];
  signal?: AbortSignal;
}

interface BoundTool {
  contract: ToolContract;
  run: (args: unknown, ctx: Context) => Promise<string>;
}

function bind<A extends z.ZodTypeAny>(
  contract: ToolContract<A>,
  run: (args: z.output<A>, ctx: Context) => Promise<string>,
): BoundTool {
  return { contract, run: run as BoundTool["run"] };
}

function size(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return ` (${bytes} B)`;
  if (bytes < 1024 * 1024) return ` (${(bytes / 1024).toFixed(1)} KB)`;
  return ` (${(bytes / 1024 / 1024).toFixed(1)} MB)`;
}

function clip(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (output cut at ${MAX_OUTPUT_CHARS} characters)`
    : text;
}

function lineCount(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function read(path: string, ctx: Context): Promise<ReadResult> {
  return invoke<ReadResult>("agent_fs_read", { roots: ctx.roots, path });
}

const bindings: BoundTool[] = [
  bind(listFilesTool, async (args, ctx) => {
    const out = await invoke<Listing>("agent_fs_list", {
      roots: ctx.roots,
      path: args.path ?? "",
      depth: args.depth,
    });
    if (out.entries.length === 0) return `${out.path} is empty.`;
    const lines = out.entries.map((e) =>
      e.isDir ? `${e.path}/` : `${e.path}${size(e.size)}`,
    );
    const head = out.path ? `Contents of ${out.path}:` : "Shared folders:";
    const tail = out.truncated ? "\n… (listing cut short)" : "";
    return clip(`${head}\n${lines.join("\n")}${tail}`);
  }),

  bind(readFileTool, async (args, ctx) => {
    const file = await read(args.path, ctx);
    if (!file.exists) return `Cannot read ${file.path}: no such file.`;
    const content = file.content ?? "";
    const lines = content.split("\n");
    if (content.endsWith("\n")) lines.pop();
    if (lines.length === 0) return `${file.path} is empty.`;
    const start = args.offset - 1;
    if (start >= lines.length) {
      return `Cannot read from line ${args.offset}: ${file.path} has ${lines.length} lines.`;
    }
    const out: string[] = [];
    let chars = 0;
    let last = start;
    for (let i = start; i < lines.length && i < start + args.limit; i++) {
      const row = `${i + 1}\t${lines[i]}`;
      if (chars + row.length > MAX_OUTPUT_CHARS) break;
      out.push(row);
      chars += row.length + 1;
      last = i;
    }
    const more =
      last + 1 < lines.length
        ? `\n(lines ${start + 1}-${last + 1} of ${lines.length}; read on with offset ${last + 2})`
        : "";
    return `${file.path}:\n${out.join("\n")}${more}`;
  }),

  bind(searchFilesTool, async (args, ctx) => {
    const out = await invoke<SearchResult>("agent_fs_search", {
      roots: ctx.roots,
      query: args.query,
      path: args.path ?? "",
      caseSensitive: args.caseSensitive,
      maxResults: SEARCH_LIMIT,
    });
    if (out.matches.length === 0) return `No matches for "${args.query}".`;
    const lines = out.matches.map((m) =>
      m.line === null
        ? `${m.path} (name matches)`
        : `${m.path}:${m.line}: ${m.text}`,
    );
    const tail = out.truncated
      ? `\n… (stopped at ${SEARCH_LIMIT} matches)`
      : "";
    return clip(`${lines.join("\n")}${tail}`);
  }),

  bind(writeFileTool, async (args, ctx) => {
    const before = await read(args.path, ctx);
    const approved = await requestApproval(
      {
        title: before.exists ? "Replace file" : "Create file",
        path: before.path,
        diff: lineDiff(before.content ?? "", args.content),
      },
      ctx.signal,
    );
    if (!approved) return DECLINED;
    const out = await invoke<{ path: string; created: boolean }>(
      "agent_fs_write",
      { roots: ctx.roots, path: args.path, content: args.content },
    );
    notifyFsChanged([out.path]);
    return `${out.created ? "Created" : "Replaced"} ${out.path} (${lineCount(args.content)} lines).`;
  }),

  bind(editFileTool, async (args, ctx) => {
    const file = await read(args.path, ctx);
    if (!file.exists) return `Cannot edit ${file.path}: no such file.`;
    const content = file.content ?? "";
    const count = content.split(args.oldText).length - 1;
    if (count === 0) {
      return `Cannot edit ${file.path}: oldText was not found. Read the file and copy the text exactly, including whitespace.`;
    }
    if (count > 1 && !args.replaceAll) {
      return `Cannot edit ${file.path}: oldText appears ${count} times. Include more surrounding text so it is unique, or set replaceAll.`;
    }
    const next = args.replaceAll
      ? content.split(args.oldText).join(args.newText)
      : content.replace(args.oldText, () => args.newText);
    const approved = await requestApproval(
      { title: "Edit file", path: file.path, diff: lineDiff(content, next) },
      ctx.signal,
    );
    if (!approved) return DECLINED;
    await invoke("agent_fs_write", {
      roots: ctx.roots,
      path: file.path,
      content: next,
    });
    notifyFsChanged([file.path]);
    return `Edited ${file.path} (${count} replacement${count === 1 ? "" : "s"}).`;
  }),

  bind(createFolderTool, async (args, ctx) => {
    const approved = await requestApproval(
      { title: "Create folder", path: args.path },
      ctx.signal,
    );
    if (!approved) return DECLINED;
    const out = await invoke<{ path: string; created: boolean }>(
      "agent_fs_mkdir",
      { roots: ctx.roots, path: args.path },
    );
    notifyFsChanged([out.path]);
    return out.created
      ? `Created folder ${out.path}.`
      : `${out.path} already exists.`;
  }),

  bind(moveFileTool, async (args, ctx) => {
    const approved = await requestApproval(
      { title: "Move", path: args.from, to: args.to },
      ctx.signal,
    );
    if (!approved) return DECLINED;
    const out = await invoke<{ from: string; path: string }>("agent_fs_move", {
      roots: ctx.roots,
      from: args.from,
      to: args.to,
    });
    notifyFsChanged([out.from, out.path]);
    return `Moved ${out.from} to ${out.path}.`;
  }),

  bind(deleteFileTool, async (args, ctx) => {
    const approved = await requestApproval(
      { title: "Move to Trash", path: args.path },
      ctx.signal,
    );
    if (!approved) return DECLINED;
    const out = await invoke<{ path: string }>("agent_fs_delete", {
      roots: ctx.roots,
      path: args.path,
    });
    notifyFsChanged([out.path]);
    return `Moved ${out.path} to the Trash.`;
  }),
];

const registry = new Map(bindings.map((b) => [b.contract.name, b]));

export async function runFileTool(
  name: string,
  args: Record<string, unknown>,
  ctx: Context,
): Promise<string> {
  const tool = registry.get(name);
  if (!tool) return `Unknown tool: ${name}`;
  const parsed = tool.contract.args.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`)
      .join("; ");
    return `Invalid arguments for ${name}: ${issues}`;
  }
  try {
    return await tool.run(parsed.data, ctx);
  } catch (err) {
    return `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** The file tools for one turn, or undefined where there is no disk to reach
 *  (the web build) or nothing shared in the sidebar. Roots are re-read on each
 *  call so a folder removed mid-chat stops being reachable at once. */
export function fileClientTools(signal?: AbortSignal): ClientTools | undefined {
  if (!isFsAvailable) return undefined;
  const roots = loadRoots();
  if (roots.length === 0) return undefined;
  return {
    tools: fileTools.map((t) => t.name),
    roots,
    runTool: (name, args) =>
      runFileTool(name, args, { roots: loadRoots(), signal }),
  };
}
