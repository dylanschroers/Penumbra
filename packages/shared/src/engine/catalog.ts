// Reading an OpenAI-compatible /v1/models listing.
//
// Shared because two callers need the same answer and must not drift: the
// status pill (OpenAiEngine.getStatus) and the benchmark route, which records
// what actually served a run rather than what the user typed. The rule below is
// subtle enough that a second copy would eventually disagree with the first.

/** One entry of a `/v1/models` response. `loaded` is Studio's; llama-server
 *  omits it. */
export interface ModelCatalogEntry {
  id?: string;
  loaded?: boolean;
}

/**
 * The model a completion would actually run against, or null when nothing is
 * resident.
 *
 * The two backends list different things. llama-server advertises only what it
 * has resident and omits `loaded` entirely, so the first entry is servable.
 * Unsloth Studio also lists models that are merely downloaded, marking each
 * `loaded: true|false` — taking entries[0] there reports a model sitting on
 * disk, and the next completion then fails against a backend with nothing
 * loaded. (Verified against studio/backend/routes/inference.py →
 * _openai_catalog_objects.)
 */
export function pickLoadedModel(
  entries: ModelCatalogEntry[],
): string | undefined {
  const loaded = entries.find((m) => m.loaded === true);
  const marksLoaded = entries.some((m) => typeof m.loaded === "boolean");
  return loaded?.id ?? (marksLoaded ? undefined : entries[0]?.id);
}
