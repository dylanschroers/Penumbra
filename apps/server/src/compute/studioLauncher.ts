import { type ChildProcess, spawn } from "node:child_process";

// Bare `unsloth studio` starts the API on 127.0.0.1:8888 with no model loaded;
// cold start is ~45s. `shell: true` is safe because the command is server
// config, never client input, and it resolves PATH and .exe/.cmd on Windows.

/** Empty UNSLOTH_LAUNCH_CMD disables launching. */
export function launchCommand(): string | null {
  const v = process.env.UNSLOTH_LAUNCH_CMD;
  if (v === undefined) return "unsloth studio";
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

export function isLaunchConfigured(): boolean {
  return launchCommand() !== null;
}

/** Covers Studio's ~45s cold start. */
const LAUNCH_DEBOUNCE_MS = 90_000;
let launchingUntil = 0;

export type LaunchOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: "not_configured" | "already_launching" | "spawn_failed";
      message?: string;
    };

/** Detached so it outlives the request. */
export function launchStudio(spawnFn: typeof spawn = spawn): LaunchOutcome {
  const cmd = launchCommand();
  if (!cmd) return { ok: false, reason: "not_configured" };
  if (Date.now() < launchingUntil) {
    return { ok: false, reason: "already_launching" };
  }
  try {
    const child: ChildProcess = spawnFn(cmd, {
      shell: true,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    launchingUntil = Date.now() + LAUNCH_DEBOUNCE_MS;
    return { ok: true };
  } catch (err) {
    // Missing `unsloth` on PATH (ENOENT) lands here.
    return {
      ok: false,
      reason: "spawn_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Tests only. */
export function resetLaunchDebounce(): void {
  launchingUntil = 0;
}

/** Empty UNSLOTH_STOP_CMD disables stopping. */
export function stopCommand(): string | null {
  const v = process.env.UNSLOTH_STOP_CMD;
  if (v === undefined) return "unsloth studio stop";
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

export function isStopConfigured(): boolean {
  return stopCommand() !== null;
}

export type StopOutcome =
  | { ok: true }
  | { ok: false; reason: "not_configured" | "spawn_failed"; message?: string };

/** Also clears the launch debounce so stop-then-launch works. */
export function stopStudio(spawnFn: typeof spawn = spawn): StopOutcome {
  const cmd = stopCommand();
  if (!cmd) return { ok: false, reason: "not_configured" };
  try {
    const child: ChildProcess = spawnFn(cmd, {
      shell: true,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    launchingUntil = 0;
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: "spawn_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
