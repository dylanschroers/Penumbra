import { migrateStorageKey } from "@penumbra/shared";
import { useCallback, useEffect, useState } from "react";
import { isFsAvailable, pickFolder } from "../../fs/fsClient";

// The picked folder persists (localStorage); the scan never does.
// Desktop-only.

export interface FileLibrary<T> {
  available: boolean;
  dir: string | null;
  items: T[];
  scanning: boolean;
  error: string | null;
  pick(): Promise<void>;
  rescan(): Promise<void>;
  clear(): void;
}

export function useFileLibrary<T>(
  storageKey: string,
  scan: (dir: string) => Promise<T[]>,
  legacyStorageKey?: string,
): FileLibrary<T> {
  const [dir, setDir] = useState<string | null>(() => {
    // Before the first read: an effect would run too late.
    if (legacyStorageKey) migrateStorageKey(legacyStorageKey, storageKey);
    return typeof localStorage === "undefined"
      ? null
      : localStorage.getItem(storageKey);
  });
  const [items, setItems] = useState<T[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runScan = useCallback(
    async (target: string) => {
      setScanning(true);
      setError(null);
      try {
        setItems(await scan(target));
      } catch (err) {
        setItems([]);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setScanning(false);
      }
    },
    [scan],
  );

  useEffect(() => {
    if (isFsAvailable && dir) void runScan(dir);
    else setItems([]);
  }, [dir, runScan]);

  const pick = useCallback(async () => {
    try {
      const picked = await pickFolder();
      if (!picked) return;
      localStorage.setItem(storageKey, picked);
      setDir(picked);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [storageKey]);

  const rescan = useCallback(async () => {
    if (dir) await runScan(dir);
  }, [dir, runScan]);

  const clear = useCallback(() => {
    localStorage.removeItem(storageKey);
    setDir(null);
  }, [storageKey]);

  return {
    available: isFsAvailable,
    dir,
    items,
    scanning,
    error,
    pick,
    rescan,
    clear,
  };
}
