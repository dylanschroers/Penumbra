import { describe, expect, it, vi } from "vitest";
import { withClientTools } from "./clientTools";
import { OpenAiEngine } from "./OpenAiEngine";
import type { AgentEvent, ClientTools } from "./types";

const base = {
  tools: [],
  system: "sys",
  runTool: vi.fn().mockResolvedValue("engine ran it"),
};

function client(overrides: Partial<ClientTools> = {}): ClientTools {
  return {
    tools: ["read_file", "not_a_real_tool"],
    roots: ["/home/me/notes"],
    runTool: vi.fn().mockResolvedValue("client ran it"),
    ...overrides,
  };
}

describe("withClientTools", () => {
  it("leaves bindings alone with no client tools or no shared folders", () => {
    expect(withClientTools(base)).toBe(base);
    expect(withClientTools(base, client({ roots: [] }))).toBe(base);
  });

  it("advertises only known file tools and names the folders", () => {
    const merged = withClientTools(base, client());
    expect(merged.tools.map((t) => t.function.name)).toEqual(["read_file"]);
    expect(merged.system).toContain('"/home/me/notes"');
  });

  it("sends file calls to the client and everything else to the engine", async () => {
    const c = client();
    const merged = withClientTools(base, c);
    expect(await merged.runTool("read_file", { path: "a" })).toBe(
      "client ran it",
    );
    expect(await merged.runTool("not_a_real_tool", {})).toBe("engine ran it");
    expect(c.runTool).toHaveBeenCalledTimes(1);
  });
});

describe("OpenAiEngine with client tools", () => {
  it("offers them to the model and runs the call through the client", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const replies = [
      {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "c1",
                  function: {
                    name: "read_file",
                    arguments: '{"path":"/home/me/notes/a.md"}',
                  },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ message: { content: "It says hi." } }] },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes("/v1/models")) {
          return { ok: true, status: 200, json: async () => ({ data: [] }) };
        }
        bodies.push(JSON.parse(init?.body as string));
        return { ok: true, status: 200, json: async () => replies.shift() };
      }),
    );
    const c = client();
    const engine = new OpenAiEngine({
      bindings: base,
      baseURL: "http://test",
      model: "m",
    });
    const events: AgentEvent[] = [];
    for await (const ev of engine.runAgent(
      [{ role: "user", content: "what's in a.md" }],
      undefined,
      c,
    )) {
      events.push(ev);
    }
    const tools = bodies[0]?.tools as Array<{ function: { name: string } }>;
    expect(tools.map((t) => t.function.name)).toContain("read_file");
    expect(c.runTool).toHaveBeenCalledWith("read_file", {
      path: "/home/me/notes/a.md",
    });
    expect(events).toEqual([
      {
        kind: "tool",
        name: "read_file",
        args: { path: "/home/me/notes/a.md" },
        result: "client ran it",
      },
      { kind: "answer", text: "It says hi." },
    ]);
    vi.unstubAllGlobals();
  });
});
