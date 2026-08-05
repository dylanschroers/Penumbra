import { type ChildProcess, spawn } from "node:child_process";

// Starting the local Unsloth Studio from the UI.
//
// Studio is co-located with this server on the GPU host (docs/MODEL_LAB.md →
// Deployment topology), so the server is in a position to start the process;
// the loopback-only route in ./routes is what safely exposes that. Verified
// against the CLI: bare `unsloth studio` brings up the API server on
// 127.0.0.1:8888 with *no model loaded*, which is exactly what a launch needs —
// the compute panel's own model picker then loads one. Cold start is ~45s (it
// imports torch/unsloth first), so nothing here waits on readiness; the
// /compute/targets poll flips the card to ready when the port answers.
//
// The command is server-side configuration and never client input, so `shell:
// true` is safe here — and it is what lets one string ("unsloth studio")
// resolve a PATH binary and its subcommand across platforms without this file
// re-parsing argv or worrying about a .exe/.cmd suffix on Windows.

/**
 * The launch command, or null when launching is disabled.
 *
 * Defaults to the verified `unsloth studio`. Set UNSLOTH_LAUNCH_CMD to override
 * it, or to an empty string to turn the feature off entirely — in which case
 * the button never appears (canLaunch stays false) and the route refuses.
 */
export function launchCommand(): string | null {
  const v = process.env.UNSLOTH_LAUNCH_CMD;
  if (v === undefined) return "unsloth studio";
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

export function isLaunchConfigured(): boolean {
  return launchCommand() !== null;
}

/** Covers Studio's cold start, so a second click during the ~45s startup does
 *  not spawn a second process racing the first for the port. */
const LAUNCH_DEBOUNCE_MS = 90_000;
let launchingUntil = 0;

export type LaunchOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: "not_configured" | "already_launching" | "spawn_failed";
      message?: string;
    };

/**
 * Spawn the configured Studio process, detached so it outlives the request and
 * so this server's lifetime is not tied to it. Injectable spawn for tests,
 * which must not actually start a GPU server.
 */
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
    // A missing `unsloth` on PATH lands here (ENOENT). Reported rather than
    // thrown so the route answers with a message instead of a bare 500.
    return {
      ok: false,
      reason: "spawn_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Clear the debounce. Tests only, so one case's launch does not block the
 *  next's. */
export function resetLaunchDebounce(): void {
  launchingUntil = 0;
}
