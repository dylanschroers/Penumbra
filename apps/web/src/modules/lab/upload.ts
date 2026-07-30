// Transfer a client-local model or dataset to the Studio host before training.
// The picker gives a path only this device can read; training runs on the
// server, so the file has to go across first. Files stream in chunks pulled from
// disk (fsClient.readChunk), so a multi-GB model never sits in the webview whole.
//
// Datasets are one file. A model is usually a directory: we list it, ask the
// server which files it still needs (it may already hold a copy), and send only
// those. A standalone `.gguf` is a single file and goes across on its own — the
// folder around it may hold a dozen other quants of the same weights, and none
// of them were asked for.

import { listDir, readChunk } from "../../fs/fsClient";

const CHUNK = 4 * 1024 * 1024;

export interface UploadTarget {
  serverURL: string;
  token?: string;
}

/** Bytes uploaded so far, out of a known total. */
export type UploadProgress = (done: number, total: number) => void;

/** Last path segment, tolerant of `/` and `\`. */
function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function headers(token: string | undefined, extra?: Record<string, string>) {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

/** Bytes as a rounded GB, for a message a person can act on. */
function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * Turn a failed upload response into an error worth showing. The server names
 * the conditions a user can do something about — a full disk above all — so
 * those get a plain-language message rather than a status code.
 */
async function uploadError(res: Response, what: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as {
    error?: string;
    need?: number;
    free?: number;
  } | null;
  if (body?.error === "insufficient_space") {
    const sizes =
      typeof body.need === "number" && typeof body.free === "number"
        ? ` (needs ${gb(body.need)}, ${gb(body.free)} free)`
        : "";
    return new Error(
      `${what} failed: the server host is out of disk space${sizes}`,
    );
  }
  return new Error(`${what} failed (server responded ${res.status})`);
}

/** Stream one local file to `<kind>/<rel>` on the host. Returns the host path.
 *  `onChunk` reports bytes sent so a caller can aggregate progress. */
async function uploadFile(
  target: UploadTarget,
  kind: "datasets" | "models",
  rel: string,
  localPath: string,
  onChunk?: (bytes: number) => void,
): Promise<string> {
  let offset = 0;
  let path = "";
  for (;;) {
    const chunk = await readChunk(localPath, offset, CHUNK);
    // Nothing left — but still send an empty offset-0 write to create the file.
    if (chunk.byteLength === 0 && offset > 0) break;

    const url = `${target.serverURL}/lab/upload?kind=${kind}&rel=${encodeURIComponent(
      rel,
    )}&offset=${offset}`;
    const res = await fetch(url, {
      method: "POST",
      headers: headers(target.token, {
        "Content-Type": "application/octet-stream",
      }),
      body: chunk,
    });
    if (!res.ok) throw await uploadError(res, `upload of ${rel}`);
    path = ((await res.json()) as { path: string }).path;

    offset += chunk.byteLength;
    onChunk?.(chunk.byteLength);
    if (chunk.byteLength < CHUNK) break; // short read → EOF
  }
  return path;
}

/** Upload a dataset file. Returns the host path to train from. */
export async function uploadDataset(
  target: UploadTarget,
  localPath: string,
  onProgress?: UploadProgress,
): Promise<string> {
  // Total is unknown without a stat; report against bytes-so-far as the total so
  // the bar reads as steady progress rather than jumping.
  let done = 0;
  return uploadFile(target, "datasets", basename(localPath), localPath, (n) => {
    done += n;
    onProgress?.(done, done);
  });
}

interface LocalFile {
  /** Path relative to the model directory, POSIX-separated. */
  rel: string;
  path: string;
  size: number;
}

/** List every file under a model directory, skipping hidden entries (e.g. the
 *  `.cache` a HuggingFace download leaves behind). */
async function collectFiles(dir: string): Promise<LocalFile[]> {
  const files: LocalFile[] = [];
  const stack: { path: string; prefix: string }[] = [{ path: dir, prefix: "" }];
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) break;
    const { entries } = await listDir(item.path);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = item.prefix ? `${item.prefix}/${entry.name}` : entry.name;
      if (entry.isDir) {
        stack.push({ path: entry.path, prefix: rel });
      } else {
        files.push({ rel, path: entry.path, size: entry.size ?? 0 });
      }
    }
  }
  return files;
}

/**
 * Upload a model — a directory of weights, or a single `.gguf` file. For a
 * directory, asks the server which files it still needs (a full copy already
 * there is skipped) and sends only those. Returns the host path to use as the
 * base model.
 */
export async function uploadModel(
  target: UploadTarget,
  localPath: string,
  onProgress?: UploadProgress,
): Promise<string> {
  const name = basename(localPath);

  // One file, not a directory: listing it would fail, and its siblings are other
  // quants the user didn't pick.
  if (name.toLowerCase().endsWith(".gguf")) {
    let sent = 0;
    return uploadFile(target, "models", name, localPath, (n) => {
      sent += n;
      onProgress?.(sent, sent);
    });
  }

  const files = await collectFiles(localPath);

  const planRes = await fetch(`${target.serverURL}/lab/models/plan`, {
    method: "POST",
    headers: headers(target.token, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      name,
      files: files.map((f) => ({ rel: f.rel, size: f.size })),
    }),
  });
  if (!planRes.ok) throw await uploadError(planRes, `upload of ${name}`);
  const plan = (await planRes.json()) as { path: string; need: string[] };

  const needed = new Set(plan.need);
  const toSend = files.filter((f) => needed.has(f.rel));
  const total = toSend.reduce((sum, f) => sum + f.size, 0);
  let done = 0;

  for (const file of toSend) {
    await uploadFile(
      target,
      "models",
      `${name}/${file.rel}`,
      file.path,
      (n) => {
        done += n;
        onProgress?.(done, total);
      },
    );
  }
  return plan.path;
}
