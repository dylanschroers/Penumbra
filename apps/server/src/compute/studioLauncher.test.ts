import type { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isLaunchConfigured,
  isStopConfigured,
  launchCommand,
  launchStudio,
  resetLaunchDebounce,
  stopCommand,
  stopStudio,
} from "./studioLauncher";

// The launcher's whole job is turning a config string into one detached spawn,
// once. These pin the three things that decide whether it spawns at all —
// configured, not already launching, spawn did not throw — and the shape of the
// spawn, without starting a real GPU server.

const ORIGINAL = process.env.UNSLOTH_LAUNCH_CMD;
const ORIGINAL_STOP = process.env.UNSLOTH_STOP_CMD;

/** A spawn stand-in returning a child with the one method launchStudio calls. */
function fakeSpawn() {
  const unref = vi.fn();
  const fn = vi.fn(() => ({ unref }) as unknown as ReturnType<typeof spawn>);
  return { fn: fn as unknown as typeof spawn, calls: fn, unref };
}

beforeEach(() => resetLaunchDebounce());
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.UNSLOTH_LAUNCH_CMD;
  else process.env.UNSLOTH_LAUNCH_CMD = ORIGINAL;
  if (ORIGINAL_STOP === undefined) delete process.env.UNSLOTH_STOP_CMD;
  else process.env.UNSLOTH_STOP_CMD = ORIGINAL_STOP;
});

describe("launchCommand", () => {
  it("defaults to the verified `unsloth studio`", () => {
    delete process.env.UNSLOTH_LAUNCH_CMD;
    expect(launchCommand()).toBe("unsloth studio");
    expect(isLaunchConfigured()).toBe(true);
  });

  it("honours an override", () => {
    process.env.UNSLOTH_LAUNCH_CMD = "conda run -n unsloth unsloth studio";
    expect(launchCommand()).toBe("conda run -n unsloth unsloth studio");
  });

  it("treats an empty value as disabled, not as the default", () => {
    process.env.UNSLOTH_LAUNCH_CMD = "   ";
    expect(launchCommand()).toBeNull();
    expect(isLaunchConfigured()).toBe(false);
  });
});

describe("launchStudio", () => {
  it("spawns the command detached and unref'd, once", () => {
    delete process.env.UNSLOTH_LAUNCH_CMD;
    const spawn = fakeSpawn();

    expect(launchStudio(spawn.fn)).toEqual({ ok: true });
    expect(spawn.calls).toHaveBeenCalledTimes(1);
    // shell:true is what lets the one string resolve a PATH binary + subcommand.
    expect(spawn.calls).toHaveBeenCalledWith("unsloth studio", {
      shell: true,
      detached: true,
      stdio: "ignore",
    });
    // Detached from this process's lifetime.
    expect(spawn.unref).toHaveBeenCalledOnce();
  });

  it("refuses a second launch inside the debounce window", () => {
    delete process.env.UNSLOTH_LAUNCH_CMD;
    const spawn = fakeSpawn();

    expect(launchStudio(spawn.fn).ok).toBe(true);
    expect(launchStudio(spawn.fn)).toEqual({
      ok: false,
      reason: "already_launching",
    });
    // The refusal did not spawn a second process racing for the port.
    expect(spawn.calls).toHaveBeenCalledTimes(1);
  });

  it("refuses when launching is disabled", () => {
    process.env.UNSLOTH_LAUNCH_CMD = "";
    const spawn = fakeSpawn();
    expect(launchStudio(spawn.fn)).toEqual({
      ok: false,
      reason: "not_configured",
    });
    expect(spawn.calls).not.toHaveBeenCalled();
  });

  it("reports a spawn that throws rather than letting it escape", () => {
    delete process.env.UNSLOTH_LAUNCH_CMD;
    const throwing = (() => {
      throw new Error("spawn unsloth ENOENT");
    }) as unknown as typeof spawn;
    const outcome = launchStudio(throwing);
    expect(outcome).toMatchObject({ ok: false, reason: "spawn_failed" });
    expect(outcome.ok === false && outcome.message).toContain("ENOENT");
  });
});

describe("stopCommand", () => {
  it("defaults to `unsloth studio stop`", () => {
    delete process.env.UNSLOTH_STOP_CMD;
    expect(stopCommand()).toBe("unsloth studio stop");
    expect(isStopConfigured()).toBe(true);
  });

  it("treats an empty value as disabled", () => {
    process.env.UNSLOTH_STOP_CMD = "";
    expect(stopCommand()).toBeNull();
    expect(isStopConfigured()).toBe(false);
  });
});

describe("stopStudio", () => {
  it("spawns the stop command detached, and clears the launch debounce", () => {
    delete process.env.UNSLOTH_STOP_CMD;
    // Arm the debounce, then prove a stop clears it so a relaunch is not
    // refused as still-launching.
    launchStudio(fakeSpawn().fn);
    expect(launchStudio(fakeSpawn().fn)).toMatchObject({
      reason: "already_launching",
    });

    const spawn = fakeSpawn();
    expect(stopStudio(spawn.fn)).toEqual({ ok: true });
    expect(spawn.calls).toHaveBeenCalledWith("unsloth studio stop", {
      shell: true,
      detached: true,
      stdio: "ignore",
    });
    expect(spawn.unref).toHaveBeenCalledOnce();
    // Debounce cleared: a fresh launch is allowed again.
    expect(launchStudio(fakeSpawn().fn)).toEqual({ ok: true });
  });

  it("refuses when stopping is disabled", () => {
    process.env.UNSLOTH_STOP_CMD = "";
    const spawn = fakeSpawn();
    expect(stopStudio(spawn.fn)).toEqual({
      ok: false,
      reason: "not_configured",
    });
    expect(spawn.calls).not.toHaveBeenCalled();
  });
});
