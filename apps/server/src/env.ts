// Imported first in main.ts: Studio clients read env at construction. A
// missing .env is fine.
try {
  process.loadEnvFile();
} catch {}
