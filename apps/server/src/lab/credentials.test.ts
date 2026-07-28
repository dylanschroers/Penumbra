import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCredentialStore } from "./credentials";

// The point of this store is that a rotated Studio key survives a restart
// without an .env edit. Getting the precedence wrong means either the UI
// silently does nothing (env winning) or a deployment can't set a default.
let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
});

const env = { UNSLOTH_BASE_URL: "http://env:8888", UNSLOTH_API_KEY: "env-key" };

describe("createCredentialStore", () => {
  it("reads the environment until something is set", () => {
    const creds = createCredentialStore(db, env);
    expect(creds.current()).toEqual({
      baseURL: "http://env:8888",
      apiKey: "env-key",
      source: "env",
    });
  });

  it("falls back to Studio's default address with no environment at all", () => {
    const creds = createCredentialStore(db, {});
    expect(creds.current()).toMatchObject({
      baseURL: "http://127.0.0.1:8888",
      apiKey: undefined,
      source: "env",
    });
  });

  it("prefers a stored value over the environment", () => {
    const creds = createCredentialStore(db, env);
    creds.set({ apiKey: "rotated" });
    expect(creds.current()).toEqual({
      // Untouched, so it still resolves from the environment.
      baseURL: "http://env:8888",
      apiKey: "rotated",
      source: "settings",
    });
  });

  it("survives a restart", () => {
    createCredentialStore(db, env).set({
      baseURL: "http://studio.lan:8888",
      apiKey: "rotated",
    });
    // A second store over the same database is what the next boot sees.
    expect(createCredentialStore(db, env).current()).toEqual({
      baseURL: "http://studio.lan:8888",
      apiKey: "rotated",
      source: "settings",
    });
  });

  it("treats an empty key as a deliberate no-bearer, not a missing one", () => {
    // A trusted-LAN Studio runs without a key, and that choice has to stick
    // rather than falling through to whatever .env still holds.
    const creds = createCredentialStore(db, env);
    creds.set({ apiKey: "" });
    expect(creds.current()).toMatchObject({
      apiKey: undefined,
      source: "settings",
    });
  });

  it("goes back to the environment when cleared", () => {
    const creds = createCredentialStore(db, env);
    creds.set({ baseURL: "http://studio.lan:8888", apiKey: "rotated" });
    expect(creds.clear()).toEqual({
      baseURL: "http://env:8888",
      apiKey: "env-key",
      source: "env",
    });
  });

  it("announces every change so the clients built from it are rebuilt", () => {
    const creds = createCredentialStore(db, env);
    const seen = vi.fn();
    creds.onChange(seen);

    creds.set({ apiKey: "rotated" });
    creds.clear();

    expect(seen).toHaveBeenCalledTimes(2);
    expect(seen.mock.calls[0]?.[0]).toMatchObject({ apiKey: "rotated" });
    expect(seen.mock.calls[1]?.[0]).toMatchObject({ source: "env" });
  });
});
