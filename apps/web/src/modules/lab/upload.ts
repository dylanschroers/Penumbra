// Streams client-local files to the Studio host in chunks, so multi-GB models
// never sit in the webview. For a model directory, uploads only what the
// server says it's missing. A standalone `.gguf` goes alone: its siblings are
// other quants.

import { listDir, readChunk } from "../../fs/fsClient";

const CHUNK = 4 * 1024 * 1024;

export interface UploadTarget {
  serverURL: string;
  token?: string;
}

export type UploadProgress = (done: number, total: number) => void;

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

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Turns server error codes (a full disk above all) into plain messages. */
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
    // An empty offset-0 write still creates the file.
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

export async function uploadDataset(
  target: UploadTarget,
  localPath: string,
  onProgress?: UploadProgress,
): Promise<string> {
  // Total unknown without a stat, so report bytes-so-far as the total.
  let done = 0;
  return uploadFile(target, "datasets", basename(localPath), localPath, (n) => {
    done += n;
    onProgress?.(done, done);
  });
}

interface LocalFile {
  rel: string;
  path: string;
  size: number;
}

/** Skips hidden entries like a HF download's `.cache`. */
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

/** Returns the host path to use as the base model. */
export async function uploadModel(
  target: UploadTarget,
  localPath: string,
  onProgress?: UploadProgress,
): Promise<string> {
  const name = basename(localPath);

  // Listing a file fails, and its siblings are other quants.
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
