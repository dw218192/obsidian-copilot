/**
 * Fork-local tool configuration.
 *
 * This self-hosted fork runs against the user's own LLM endpoint and has no valid
 * Copilot Plus license, so tools that depend on Brevilabs' paid backend cannot
 * work — they only add noise (the model tries them and they fail at the server).
 * Their ids are listed here and filtered out at registration time.
 *
 * Implemented as a filter (not by deleting entries from BUILTIN_TOOLS) so it stays
 * a small, localized change that survives merges from upstream. Empty the set to
 * restore all tools. Not for upstreaming.
 */
export const FORK_DISABLED_TOOL_IDS: ReadonlySet<string> = new Set([
  "webSearch", // Brevilabs /websearch — requires a paid license
  "youtubeTranscription", // Brevilabs /youtube4llm — requires a paid license
]);
