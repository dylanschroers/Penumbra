import type { AuthContext, Device, IssuedDevice } from "@penumbra/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

// Admin controls show only when the server reports the caller as loopback
// (GET /auth/context).

export interface Devices {
  context: AuthContext | null;
  devices: Device[];
  /** Shown exactly once; the server never returns it again. */
  minted: IssuedDevice | null;
  error: string | null;
  busy: boolean;
  mint: (label: string) => Promise<void>;
  revoke: (id: string) => Promise<void>;
  dismissMinted: () => void;
}

export function useDevices(enabled: boolean): Devices {
  const [context, setContext] = useState<AuthContext | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [minted, setMinted] = useState<IssuedDevice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    // An older server without /auth/context 404s; the section hides.
    let ctx: AuthContext;
    try {
      ctx = await api<AuthContext>("/auth/context");
    } catch {
      setContext({ loopback: false, requiresToken: false });
      setDevices([]);
      return;
    }
    setContext(ctx);
    // Off-loopback the list would 403.
    if (!ctx.loopback) {
      setDevices([]);
      return;
    }
    try {
      setDevices(await api<Device[]>("/auth/devices"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Only while the menu is open.
  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  const mint = useCallback(
    async (label: string) => {
      setBusy(true);
      try {
        const issued = await api<IssuedDevice>("/auth/devices", {
          method: "POST",
          body: JSON.stringify({ label }),
        });
        setMinted(issued);
        setError(null);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const revoke = useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        await api<void>(`/auth/devices/${id}`, { method: "DELETE" });
        // Clear a shown token if its device was just revoked.
        setMinted((m) => (m?.device.id === id ? null : m));
        setError(null);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return {
    context,
    devices,
    minted,
    error,
    busy,
    mint,
    revoke,
    dismissMinted: () => setMinted(null),
  };
}
