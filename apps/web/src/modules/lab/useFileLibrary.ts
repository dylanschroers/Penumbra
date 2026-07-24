import { useCallback, useEffect, useState } from "react";
import { isFsAvailable, pickFolder } from "../../fs/fsClient";

// A picked on-device folder and the scan of what it holds — the shared state
// behind the Model Lab's model and dataset libraries. The two differ only in
// what they scan for, so that (plus the storage key) is all the caller supplies.
//
// The chosen folder is remembered across launches (localStorage) and re-scanned
// on mount; the scan itself is never persisted, so it always reflects what is on
// disk right now. Desktop-only — the web build has no filesystem, so `available`
// is false there and the panel shows a hint instead.

export interface FileLibrary<T> {
  /** True on desktop, where a native folder picker and disk access exist. */
  available: boolean;
  /** The chosen folder, or null if none is set. */
  dir: string | null;
  items: T[];
  scanning: boolean;
  error: string | null;
  /** Open the OS folder picker and adopt the result (which triggers a scan). */
  pick(): Promise<void>;
  /** Re-read the current folder from disk. */
  rescan(): Promise<void>;
  /** Forget the folder and its items. */
  clear(): void;
}

export function useFileLibrary<T>(
  storageKey: string,
  scan: (dir: string) => Promise<T[]>,
): FileLibrary<T> {
  const [dir, setDir] = useState<string | null>(() =>
    typeof localStorage === "undefined"
      ? null
      : localStorage.getItem(storageKey),
  );
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

  // Scan whenever the folder changes — on mount for a remembered folder, and
  // after pick()/clear(). Clearing the folder clears the list.
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
