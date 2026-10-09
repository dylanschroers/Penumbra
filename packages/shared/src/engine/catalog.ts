// Reading an OpenAI-compatible /v1/models listing.
//
// Shared because two callers need the same answer and must not drift: the
// status pill (OpenAiEngine.getStatus) and the benchmark route, which records
// what actually served a run rather than what the user typed. The rule below is
// subtle enough that a second copy would eventually disagree with the first.

/** One entry of a `/v1/models` response. `loaded` is Studio's; llama-server
 *  omits it. `owned_by` is the OpenAI field a server uses to name itself. */
export interface ModelCatalogEntry {
  id?: string;
  loaded?: boolean;
  owned_by?: string;
}

/** Display names for the `owned_by` values servers report about themselves. */
const BACKEND_NAMES: Record<string, string> = { llamacpp: "llama.cpp" };

/**
 * The backend serving `model`, as the listing names it, or undefined when it
 * names none.
 *
 * Read from the backend rather than configured, because configuration is what
 * went stale: a Tier 1 engine labelled "unsloth studio" kept telling the model
 * so after the server was pointed at a llama-server. An unrecognised name is
 * passed through as given; only a missing one falls back to the caller's label.
 */
export function servingBackend(
  entries: ModelCatalogEntry[],
  model: string,
): string | undefined {
  const owner = entries.find((m) => m.id === model)?.owned_by?.trim();
  if (!owner) return undefined;
  return BACKEND_NAMES[owner] ?? owner;
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
