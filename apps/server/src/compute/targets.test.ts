import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { createTargetStore } from "./targets";

// Precedence (stored settings over env) and assigned vs resolved targets.
let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
});

const env = { UNSLOTH_BASE_URL: "http://env:8888", UNSLOTH_API_KEY: "env-key" };

describe("local target", () => {
  it("reads the environment until something is set", () => {
    expect(createTargetStore(db, env).credentials("local")).toEqual({
      baseURL: "http://env:8888",
      apiKey: "env-key",
    });
  });

  it("falls back to Studio's default address with no environment at all", () => {
    expect(createTargetStore(db, {}).credentials("local")).toEqual({
      baseURL: "http://127.0.0.1:8888",
      apiKey: undefined,
    });
  });

  it("prefers a stored value over the environment, field by field", () => {
    const targets = createTargetStore(db, env);
    targets.set("local", { apiKey: "rotated" });
    expect(targets.credentials("local")).toEqual({
      baseURL: "http://env:8888",
      apiKey: "rotated",
    });
  });

  it("survives a restart", () => {
    createTargetStore(db, env).set("local", {
      baseURL: "http://studio.lan:8888",
      apiKey: "rotated",
    });
    expect(createTargetStore(db, env).credentials("local")).toEqual({
      baseURL: "http://studio.lan:8888",
      apiKey: "rotated",
    });
  });

  it("treats an empty key as a deliberate no-bearer, not a missing one", () => {
    // A deliberately keyless Studio must not fall back to the env key.
    const targets = createTargetStore(db, env);
    targets.set("local", { apiKey: "" });
    expect(targets.credentials("local").apiKey).toBeUndefined();
  });

  it("goes back to the environment when cleared", () => {
    const targets = createTargetStore(db, env);
    targets.set("local", { baseURL: "http://studio.lan:8888", apiKey: "x" });
    targets.clear("local");
    expect(targets.credentials("local")).toEqual({
      baseURL: "http://env:8888",
      apiKey: "env-key",
    });
  });

  it("is always configured — it has a default address", () => {
    const local = createTargetStore(db, {}).list()[0];
    expect(local).toMatchObject({ id: "local", configured: true });
  });
});

describe("colab target", () => {
  it("starts unconfigured", () => {
    const colab = createTargetStore(db, env).list()[1];
    expect(colab).toMatchObject({ id: "colab", configured: false });
  });

  // Colab must not inherit local's env address.
  it("takes nothing from the environment", () => {
    expect(createTargetStore(db, env).credentials("colab")).toEqual({
      baseURL: "",
      apiKey: undefined,
    });
  });

  it("takes an address and key at runtime", () => {
    const targets = createTargetStore(db, env);
    targets.set("colab", {
      baseURL: "https://x.trycloudflare.com",
      apiKey: "k",
    });
    expect(targets.credentials("colab")).toEqual({
      baseURL: "https://x.trycloudflare.com",
      apiKey: "k",
    });
  });

  it("ignores a key with no address to attach it to", () => {
    const targets = createTargetStore(db, env);
    targets.set("colab", { apiKey: "orphan" });
    expect(targets.list()[1]).toMatchObject({ configured: false });
  });

  it("survives a restart, key and all", () => {
    createTargetStore(db, env).set("colab", {
      baseURL: "https://x.trycloudflare.com",
      apiKey: "k",
    });
    expect(createTargetStore(db, env).credentials("colab")).toEqual({
      baseURL: "https://x.trycloudflare.com",
      apiKey: "k",
    });
  });

  it("keeps the address when only the key is rotated", () => {
    const targets = createTargetStore(db, env);
    targets.set("colab", { baseURL: "https://x.trycloudflare.com" });
    targets.set("colab", { apiKey: "later" });
    expect(targets.credentials("colab")).toEqual({
      baseURL: "https://x.trycloudflare.com",
      apiKey: "later",
    });
  });

  // The only way a Colab address goes away, so the key must go with it.
  it("forgets it on clear, across a restart", () => {
    const targets = createTargetStore(db, env);
    targets.set("colab", {
      baseURL: "https://x.trycloudflare.com",
      apiKey: "k",
    });
    targets.clear("colab");
    expect(createTargetStore(db, env).list()[1]).toMatchObject({
      configured: false,
      hasKey: false,
    });
  });
});

describe("never returns the key itself", () => {
  it("reports only whether one is set", () => {
    const targets = createTargetStore(db, env);
    const listed = JSON.stringify(targets.list());
    expect(listed).not.toContain("env-key");
    expect(targets.list()[0]).toMatchObject({ hasKey: true });
  });

  it("reports hasKey false for a Studio running without a bearer", () => {
    expect(createTargetStore(db, {}).list()[0]).toMatchObject({
      hasKey: false,
    });
  });
});

describe("assignments", () => {
  it("defaults every role to local", () => {
    const targets = createTargetStore(db, env);
    expect(targets.assignment("chat")).toBe("local");
    expect(targets.assignment("benchmark")).toBe("local");
  });

  it("remembers a role's target across a restart", () => {
    createTargetStore(db, env).assign("chat", "colab");
    expect(createTargetStore(db, env).assignment("chat")).toBe("colab");
  });

  it("keeps roles independent", () => {
    const targets = createTargetStore(db, env);
    targets.assign("benchmark", "colab");
    expect(targets.assignment("chat")).toBe("local");
    expect(targets.assignment("benchmark")).toBe("colab");
  });

  it("resolves to local when the assigned target has no address", () => {
    const targets = createTargetStore(db, env);
    targets.assign("chat", "colab");
    expect(targets.assignment("chat")).toBe("colab");
    expect(targets.effective("chat")).toBe("local");
    expect(targets.resolve("chat").baseURL).toBe("http://env:8888");
  });

  it("honors the assignment once the target is configured", () => {
    const targets = createTargetStore(db, env);
    targets.assign("chat", "colab");
    targets.set("colab", { baseURL: "https://x.trycloudflare.com" });
    expect(targets.effective("chat")).toBe("colab");
    expect(targets.resolve("chat").baseURL).toBe("https://x.trycloudflare.com");
  });

  it("falls back again when the target is cleared out from under it", () => {
    const targets = createTargetStore(db, env);
    targets.set("colab", { baseURL: "https://x.trycloudflare.com" });
    targets.assign("chat", "colab");
    targets.clear("colab");
    expect(targets.effective("chat")).toBe("local");
  });
});
