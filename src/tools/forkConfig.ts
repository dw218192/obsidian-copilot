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

/**
 * Offer the model server's native web search (OpenAI Responses API built-in
 * `web_search` tool) instead of a client-executed search tool. The model server
 * runs the search itself and returns grounded text — we only declare the tool.
 *
 * Gated to models already using the Responses API (e.g. gpt-5.x), since the
 * built-in tool only applies there; other models receive the tools unchanged.
 * Set to false to stop offering it. Not for upstreaming.
 */
export const FORK_ENABLE_NATIVE_WEB_SEARCH: boolean = true;

/**
 * Append the built-in `web_search` tool to a bindTools() tools array when the
 * given chat model uses the OpenAI Responses API; otherwise return the array
 * unchanged. Whether the model actually invokes it is up to the model (reasoning
 * effort / prompting), not this wiring.
 */
export function withNativeWebSearch(chatModel: unknown, tools: unknown[]): unknown[] {
  if (!FORK_ENABLE_NATIVE_WEB_SEARCH) return tools;
  const usesResponsesApi = (chatModel as { useResponsesApi?: boolean })?.useResponsesApi === true;
  if (!usesResponsesApi) return tools;
  return [...tools, { type: "web_search" }];
}
