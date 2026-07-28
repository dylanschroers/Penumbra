// Prototype-only: a glyph per module for the dock/focus headers. Kept here rather
// than in the registry so the prototype stays self-contained; if this shell ships,
// this becomes an `icon` field on ModuleDefinition instead.
export const MODULE_ICONS: Record<string, string> = {
  tasks: "✅",
  color: "🎨",
  weather: "⛅",
  lab: "🧪",
  agent: "💬",
};
