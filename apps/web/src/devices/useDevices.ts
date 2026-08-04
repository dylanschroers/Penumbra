import type { AuthContext, Device, IssuedDevice } from "@penumbra/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

// Drives the device-management section of the status pill.
//
// Everything here goes through api(), so it follows the address and bearer the
// pill edits — device management runs against the same server chat and the Lab
// do, never a second one.
//
// The admin controls are shown only when the server reports the caller as
// loopback (../../server/src/devices/routes → GET /auth/context). That is the
// current stand-in for an admin flag: the client cannot judge its own vantage
// point, so the server attests to it, and until a real flag exists "you are on
// the server's own machine" is what grants management.

export interface Devices {
  /** Null until the first context fetch settles. */
  context: AuthContext | null;
  devices: Device[];
  /** The just-minted token, held so it can be shown exactly once. The server
   *  never returns it again. */
  minted: IssuedDevice | null;
  error: string | null;
  busy: boolean;
  mint: (label: string) => Promise<void>;
  revoke: (id: string) => Promise<void>;
  /** Clear the shown-once token, once the user has copied it. */
  dismissMinted: () => void;
}

export function useDevices(enabled: boolean): Devices {
  const [context, setContext] = useState<AuthContext | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [minted, setMinted] = useState<IssuedDevice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    // Context first, and on its own: it decides whether the list is even worth
    // asking for, and a failure here is different from a failure listing. An
    // older server with no /auth/context 404s, which is read as "no device
    // management" — the section hides rather than showing an error for a server
    // that simply predates the feature.
    let ctx: AuthContext;
    try {
      ctx = await api<AuthContext>("/auth/context");
    } catch {
      setContext({ loopback: false, requiresToken: false });
      setDevices([]);
      return;
    }
    setContext(ctx);
    // Off-loopback the list is admin-only and would 403 anyway; don't ask.
    if (!ctx.loopback) {
      setDevices([]);
      return;
    }
    // Listing can fail on its own without unsettling the context above, so its
    // error shows in the (now visible) panel instead of hiding it.
    try {
      setDevices(await api<Device[]>("/auth/devices"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Only while the menu is open: this component is always mounted, and there is
  // no reason to poll the server for a panel nobody is looking at.
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
        // A token shown for a device just revoked would be a live-looking
        // credential that no longer works — clear it if it was this one.
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
