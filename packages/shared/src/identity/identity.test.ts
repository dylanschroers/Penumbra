import { afterEach, describe, expect, it } from "vitest";
import { migrateStorageKey, STORAGE_NAMESPACE } from "./index";

const OLD = "penumbra.thing";
const NEW = `${STORAGE_NAMESPACE}.thing.v1`;

// This package runs its tests under Node, which has no localStorage, and that is
// the point: the server imports @penumbra/shared, so `migrateStorageKey` has to
// be callable where web storage does not exist. The stub below installs one only
// for the tests that need it, leaving the absent case genuinely absent.
function installStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
  return map;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("migrateStorageKey", () => {
  it("moves the value onto the new key and clears the old one", () => {
    const map = installStorage({ [OLD]: "kept" });
    migrateStorageKey(OLD, NEW);
    expect(map.get(NEW)).toBe("kept");
    expect(map.has(OLD)).toBe(false);
  });

  it("does nothing when there is no legacy value", () => {
    const map = installStorage();
    migrateStorageKey(OLD, NEW);
    expect(map.has(NEW)).toBe(false);
  });

  // The migration runs on every load, so it has to be safe to repeat.
  it("is idempotent", () => {
    const map = installStorage({ [OLD]: "kept" });
    migrateStorageKey(OLD, NEW);
    migrateStorageKey(OLD, NEW);
    expect(map.get(NEW)).toBe("kept");
  });

  // A value written under the current name is the live one; a legacy value still
  // lying around is stale and must not overwrite it.
  it("never lets a stale legacy value clobber the current one", () => {
    const map = installStorage({ [OLD]: "stale", [NEW]: "current" });
    migrateStorageKey(OLD, NEW);
    expect(map.get(NEW)).toBe("current");
  });

  it("still clears the old key when the new one already had a value", () => {
    const map = installStorage({ [OLD]: "stale", [NEW]: "current" });
    migrateStorageKey(OLD, NEW);
    expect(map.has(OLD)).toBe(false);
  });

  it("no-ops where there is no localStorage at all", () => {
    expect(() => migrateStorageKey(OLD, NEW)).not.toThrow();
  });

  it("survives a localStorage that throws", () => {
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {},
        removeItem: () => {},
      },
      configurable: true,
    });
    expect(() => migrateStorageKey(OLD, NEW)).not.toThrow();
  });
});
