import type { DatasetSource } from "./types";

// Telling a path apart from a model/dataset *name*. Shared because both sides
// of the lab decide things on it: the UI on whether to upload a pick before a
// run, the server on whether a remote trainer could possibly open it.

/**
 * A value that names a file on some machine — an absolute path or `~` — versus
 * a HuggingFace id (`org/name`), which any trainer can fetch for itself.
 *
 * The leading `\\` case covers Windows UNC (`\\server\share`) and verbatim
 * (`\\?\F:\...`) paths. Missing those is not cosmetic: the path then skips the
 * upload and is sent to Studio as-is, which rejects it — the file lives on the
 * client, not the training host.
 */
export const looksLocalPath = (v: string): boolean =>
  /^(~|\/|\\\\|[A-Za-z]:[\\/])/.test(v);

/**
 * Decide whether a dataset string names a HuggingFace repo or a file on the
 * Studio host. HF ids look like `owner/name` and never start with a path
 * marker, so anything `looksLocalPath` recognizes is one — as is a leading `.`
 * or a data file extension, which no HF repo id carries.
 *
 * Strictly wider than `looksLocalPath`, never narrower, and the difference is
 * the point rather than an accident: a bare `trainset.jsonl` is a file the
 * trainer can open but not a path, which matters here (it decides `hf` vs
 * `local`) and does not there (it decides whether a *client* pick needs
 * uploading first). Reusing the predicate rather than restating a subset of it
 * is what keeps that relationship true — a hand-written subset dropped drive
 * letters and UNC, so `C:\datasets\corpus` went to Studio as a repo id and the
 * run failed minutes later inside the trainer with nothing naming the cause.
 * Every path `listDatasets` reports on Windows has that shape, and it lists
 * whatever was uploaded rather than only the extensions below.
 */
export function toDatasetSource(value: string): DatasetSource {
  const trimmed = value.trim();
  const looksLikeFile =
    looksLocalPath(trimmed) ||
    trimmed.startsWith(".") ||
    /\.(jsonl|json|csv|parquet)$/i.test(trimmed);
  return looksLikeFile
    ? { kind: "local", path: trimmed }
    : { kind: "hf", id: trimmed };
}
