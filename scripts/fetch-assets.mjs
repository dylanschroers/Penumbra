// Cross-platform launcher for fetch-assets.sh. `pnpm fetch-assets` runs npm
// scripts through cmd.exe on Windows, where bash isn't on PATH even with Git
// installed (Git exposes cmd/git.exe, not bin/bash.exe). This finds a bash and
// hands off, so the .sh stays the single implementation.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "fetch-assets.sh");

const candidates =
  process.platform === "win32"
    ? [
        "bash.exe", // on PATH (Git Bash terminal, WSL shim, etc.)
        join(
          process.env.ProgramFiles ?? "C:\\Program Files",
          "Git",
          "bin",
          "bash.exe",
        ),
        join(
          process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
          "Git",
          "bin",
          "bash.exe",
        ),
      ]
    : ["bash"];

for (const bash of candidates) {
  if (bash.includes("\\") && !existsSync(bash)) continue;
  const res = spawnSync(bash, [script], { stdio: "inherit" });
  if (res.error?.code === "ENOENT") continue; // not this one; try the next
  process.exit(res.status ?? 1);
}

console.error(
  "Could not find bash. Install Git for Windows (ships Git Bash) or run " +
    "scripts/fetch-assets.sh from a bash shell.",
);
process.exit(1);
