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
 * marker, so leading `.` or `/` is the discriminator — as is a data file
 * extension, which no HF repo id carries.
 *
 * Looser than `looksLocalPath` on purpose, and not a duplicate of it: a bare
 * `trainset.jsonl` is a file the trainer can open but not a path, which matters
 * here (it decides `hf` vs `local`) and does not there (it decides whether a
 * *client* pick needs uploading first).
 */
export function toDatasetSource(value: string): DatasetSource {
  const trimmed = value.trim();
  const looksLikePath =
    trimmed.startsWith(".") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("~") ||
    /\.(jsonl|json|csv|parquet)$/i.test(trimmed);
  return looksLikePath
    ? { kind: "local", path: trimmed }
    : { kind: "hf", id: trimmed };
}
