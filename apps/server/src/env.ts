// Load apps/server/.env into process.env before anything reads it.
//
// Imported first in main.ts so it runs ahead of every other module: the Studio
// client and UnslothEngine read UNSLOTH_API_KEY / UNSLOTH_BASE_URL at
// construction time, and this must already be in place. `.env` is gitignored
// (it holds the Studio bearer); a missing file is fine — real deployments set
// the vars in the environment directly.
//
// Uses Node's built-in loader, so there is no dependency and it behaves the
// same under `tsx` (dev) and `node` (built). loadEnvFile throws when the file
// is absent; that case is expected, not an error.
try {
  process.loadEnvFile();
} catch {
  // No .env on this host — env vars come from the shell/orchestrator instead.
}
