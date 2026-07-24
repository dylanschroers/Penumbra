// Transfer a client-local model or dataset to the Studio host before training.
// The picker gives a path only this device can read; training runs on the
// server, so the file has to go across first. Files stream in chunks pulled from
// disk (fsClient.readChunk), so a multi-GB model never sits in the webview whole.
//
// Datasets are one file. Models are a directory: we list it, ask the server
// which files it still needs (it may already hold a copy), and send only those.

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
    if (!res.ok) {
      throw new Error(
        `upload of ${rel} failed (server responded ${res.status})`,
      );
    }
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
 * Upload a model directory. Asks the server which files it still needs (a full
 * copy already there is skipped), sends only those, and returns the host path to
 * the model directory to use as the base model.
 */
export async function uploadModel(
  target: UploadTarget,
  localDir: string,
  onProgress?: UploadProgress,
): Promise<string> {
  const name = basename(localDir);
  const files = await collectFiles(localDir);

  const planRes = await fetch(`${target.serverURL}/lab/models/plan`, {
    method: "POST",
    headers: headers(target.token, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      name,
      files: files.map((f) => ({ rel: f.rel, size: f.size })),
    }),
  });
  if (!planRes.ok) {
    throw new Error(`upload plan failed (server responded ${planRes.status})`);
  }
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
