import { z } from "zod";
import type { ToolContract } from "./contract";

// Contracts for the file tools. They run wherever the folders are, which is the
// desktop app: the server only forwards the calls (see clientTools below). Every
// path is confined to the folders shared in the sidebar, enforced natively in
// apps/desktop/src-tauri/src/agent_fs.rs.

const path = z
  .string()
  .min(1)
  .describe("Absolute path inside a shared folder, as list_files returns it");

export const listFilesTool = {
  name: "list_files",
  description:
    "List the files and folders in a shared folder. With no path, lists the shared folders themselves.",
  permission: "read",
  args: z.object({
    path: z
      .string()
      .describe("Folder to list; omit for the shared folders")
      .optional(),
    depth: z
      .number()
      .int()
      .min(1)
      .max(4)
      .describe("How many levels deep to list")
      .default(2),
  }),
} satisfies ToolContract;

export const readFileTool = {
  name: "read_file",
  description:
    "Read a text file. Lines come back numbered; use offset and limit to page through a long file.",
  permission: "read",
  args: z.object({
    path,
    offset: z
      .number()
      .int()
      .min(1)
      .describe("First line to return, starting at 1")
      .default(1),
    limit: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .describe("Most lines to return")
      .default(400),
  }),
} satisfies ToolContract;

export const searchFilesTool = {
  name: "search_files",
  description:
    "Find text inside files, and files whose name contains it, across the shared folders or under one folder.",
  permission: "read",
  args: z.object({
    query: z.string().min(1).describe("Text to look for"),
    path: z
      .string()
      .describe("Folder to search under; omit for all shared folders")
      .optional(),
    caseSensitive: z.boolean().describe("Match case exactly").default(false),
  }),
} satisfies ToolContract;

export const writeFileTool = {
  name: "write_file",
  description:
    "Create a text file, or replace a whole file's contents. Missing folders are created. Prefer edit_file for changing part of an existing file.",
  permission: "write",
  args: z.object({
    path,
    content: z.string().max(500_000).describe("The complete new contents"),
  }),
} satisfies ToolContract;

export const editFileTool = {
  name: "edit_file",
  description:
    "Replace exact text in a file. oldText must match the file exactly, including whitespace, and appear once unless replaceAll is set. Read the file first.",
  permission: "write",
  args: z.object({
    path,
    oldText: z.string().min(1).describe("Exact text to replace"),
    newText: z.string().describe("Text to put in its place"),
    replaceAll: z
      .boolean()
      .describe("Replace every occurrence instead of exactly one")
      .default(false),
  }),
} satisfies ToolContract;

export const createFolderTool = {
  name: "create_folder",
  description: "Create a folder, including any missing parent folders.",
  permission: "write",
  args: z.object({ path }),
} satisfies ToolContract;

export const moveFileTool = {
  name: "move_file",
  description:
    "Move or rename a file or folder. Never overwrites: fails if the destination exists.",
  permission: "write",
  args: z.object({
    from: path.describe("Current path"),
    to: path.describe("New path, including the name"),
  }),
} satisfies ToolContract;

export const deleteFileTool = {
  name: "delete_file",
  description: "Move a file or folder to the trash.",
  permission: "act",
  args: z.object({ path }),
} satisfies ToolContract;

/** Every file tool, in the order the model sees them. */
export const fileTools = [
  listFilesTool,
  readFileTool,
  searchFilesTool,
  writeFileTool,
  editFileTool,
  createFolderTool,
  moveFileTool,
  deleteFileTool,
] as const;

/** Policy for a turn that has file tools, naming the folders it can reach. */
export function filesPolicy(roots: readonly string[]): string {
  return (
    "The user has shared these folders with you: " +
    roots.map((r) => `"${r}"`).join(", ") +
    ". Use the file tools when a request involves files in them: list or " +
    "search to find things, read a file before changing it, and prefer " +
    "edit_file over rewriting a whole file. Paths outside these folders are " +
    "refused. When the user asks for a change, make it by calling the tool " +
    "straight away: the app itself shows them the change and asks them to " +
    "approve it, so do not ask for permission in your reply. If a change is " +
    "declined, do not retry it unless they ask."
  );
}

/**
 * What a client says it can run this turn, on the wire with a chat request: the
 * file tool names it binds and the folders they reach. The server advertises
 * only these, and forwards each call back to that client.
 */
export const clientToolsInput = z.object({
  tools: z.array(z.string().min(1)).max(32),
  roots: z.array(z.string().min(1)).max(64),
});

export type ClientToolsInput = z.infer<typeof clientToolsInput>;
