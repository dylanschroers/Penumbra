import type { InferenceEngine } from "@ghost/shared";
import { remoteEngine } from "./RemoteEngine";
import { localEngine } from "./LocalEngine";

export { RemoteEngine, remoteEngine } from "./RemoteEngine";
export { LocalEngine, localEngine } from "./LocalEngine";

// Which engine the app drives by default. Both implement the same
// InferenceEngine, so the agent module is unaffected by the choice.
//   - "local" (default): the embedded model, no server (Tier 0)
//   - "remote":          the Ghost server (self-hosted / cloud behind it)
// The embedded model is the local-first default; a later phase promotes this to
// a runtime capability router.
export const defaultEngine: InferenceEngine =
  import.meta.env.VITE_ENGINE === "remote" ? remoteEngine : localEngine;
