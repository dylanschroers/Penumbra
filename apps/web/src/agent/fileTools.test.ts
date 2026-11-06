import { beforeEach, describe, expect, it, vi } from "vitest";
import { ROOTS_KEY } from "../fs/roots";

const files = new Map<string, string>();
const invoke = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
  const path = args.path as string;
  switch (cmd) {
    case "agent_fs_read":
      return files.has(path)
        ? { path, exists: true, content: files.get(path) }
        : { path, exists: false };
    case "agent_fs_write": {
      const created = !files.has(path);
      files.set(path, args.content as string);
      return { path, created };
    }
    case "agent_fs_search":
      return {
        matches: [{ path: "/n/a.md", line: 2, text: "hello" }],
        truncated: false,
      };
    case "agent_fs_delete":
      files.delete(path);
      return { path };
    default:
      throw new Error(`unexpected ${cmd}`);
  }
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => invoke(cmd, args),
}));
vi.mock("../fs/fsClient", () => ({ isFsAvailable: true }));

const requestApproval = vi.fn();
vi.mock("./approvals", () => ({
  requestApproval: (...args: unknown[]) => requestApproval(...args),
}));

const { DECLINED, fileClientTools, runFileTool } = await import("./fileTools");
const ctx = { roots: ["/n"] };

beforeEach(() => {
  files.clear();
  invoke.mockClear();
  requestApproval.mockReset().mockResolvedValue(true);
  localStorage.setItem(ROOTS_KEY, JSON.stringify(["/n"]));
});

describe("fileClientTools", () => {
  it("offers every file tool over the sidebar's folders", () => {
    const tools = fileClientTools();
    expect(tools?.roots).toEqual(["/n"]);
    expect(tools?.tools).toContain("edit_file");
  });

  it("offers nothing when no folder is shared", () => {
    localStorage.setItem(ROOTS_KEY, "[]");
    expect(fileClientTools()).toBeUndefined();
  });
});

describe("read_file", () => {
  it("numbers lines and says how to read on", async () => {
    files.set("/n/a.md", "one\ntwo\nthree\n");
    const out = await runFileTool(
      "read_file",
      { path: "/n/a.md", limit: 2 },
      ctx,
    );
    expect(out).toBe(
      "/n/a.md:\n1\tone\n2\ttwo\n(lines 1-2 of 3; read on with offset 3)",
    );
  });

  it("reports a missing file", async () => {
    expect(await runFileTool("read_file", { path: "/n/x.md" }, ctx)).toMatch(
      /^Cannot read \/n\/x.md/,
    );
  });
});

describe("edit_file", () => {
  it("replaces the one match after approval", async () => {
    files.set("/n/a.md", "hello world\n");
    const out = await runFileTool(
      "edit_file",
      { path: "/n/a.md", oldText: "world", newText: "there" },
      ctx,
    );
    expect(out).toBe("Edited /n/a.md (1 replacement).");
    expect(files.get("/n/a.md")).toBe("hello there\n");
    const request = requestApproval.mock.calls[0]?.[0];
    expect(request.title).toBe("Edit file");
    expect(request.diff).toContainEqual({ kind: "add", text: "hello there" });
  });

  it("refuses an ambiguous match without asking", async () => {
    files.set("/n/a.md", "x x");
    const out = await runFileTool(
      "edit_file",
      { path: "/n/a.md", oldText: "x", newText: "y" },
      ctx,
    );
    expect(out).toMatch(/appears 2 times/);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("leaves the file alone when declined", async () => {
    files.set("/n/a.md", "keep");
    requestApproval.mockResolvedValue(false);
    const out = await runFileTool(
      "edit_file",
      { path: "/n/a.md", oldText: "keep", newText: "lose" },
      ctx,
    );
    expect(out).toBe(DECLINED);
    expect(files.get("/n/a.md")).toBe("keep");
  });
});

describe("write_file", () => {
  it("creates a file once approved", async () => {
    const out = await runFileTool(
      "write_file",
      { path: "/n/new.md", content: "a\nb\n" },
      ctx,
    );
    expect(out).toBe("Created /n/new.md (2 lines).");
    expect(requestApproval.mock.calls[0]?.[0].title).toBe("Create file");
  });
});

describe("delete_file", () => {
  it("asks first, then moves to the trash", async () => {
    files.set("/n/a.md", "x");
    expect(await runFileTool("delete_file", { path: "/n/a.md" }, ctx)).toBe(
      "Moved /n/a.md to the Trash.",
    );
    expect(requestApproval).toHaveBeenCalledOnce();
  });
});

describe("search_files", () => {
  it("lists matches as path:line", async () => {
    expect(await runFileTool("search_files", { query: "hello" }, ctx)).toBe(
      "/n/a.md:2: hello",
    );
  });
});

it("rejects arguments that fail the contract", async () => {
  expect(await runFileTool("read_file", {}, ctx)).toMatch(
    /^Invalid arguments for read_file/,
  );
});

it("reports a native error as a failed tool", async () => {
  expect(
    await runFileTool("move_file", { from: "/n/a", to: "/n/b" }, ctx),
  ).toMatch(/^Tool move_file failed: unexpected agent_fs_move/);
});
