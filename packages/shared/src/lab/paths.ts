import type { DatasetSource } from "./types";

/**
 * An absolute path or `~`, versus a HuggingFace `org/name` id. The `\\` case
 * covers Windows UNC and verbatim paths, which would otherwise go to Studio as
 * repo ids.
 */
export const looksLocalPath = (v: string): boolean =>
  /^(~|\/|\\\\|[A-Za-z]:[\\/])/.test(v);

/**
 * Wider than `looksLocalPath` on purpose: a bare `trainset.jsonl` is a file on
 * the trainer, not a repo id. Reuses the predicate so drive letters and UNC
 * paths are never misread as repo ids.
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
