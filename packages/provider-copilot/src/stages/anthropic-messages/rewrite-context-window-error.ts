export const isCopilotContextWindowError = (text: string): boolean => text.includes('Request body is too large for model context window') || text.includes('context_length_exceeded');

/**
 * Copilot's `/v1/messages` endpoint reports context-window failures with an
 * Anthropic-shape body carrying a Copilot-specific message string; Claude
 * Code's detector matches on the message substring alone (case-insensitive
 * `error.message.toLowerCase().includes('prompt is too long')`), so we
 * rewrite this body to the canonical prompt-too-long envelope and trigger
 * auto-compaction. The envelope + client-bundle evidence live in
 * `@floway-dev/protocols/anthropic-messages` (`buildPromptTooLongBody` /
 * `PROMPT_TOO_LONG_MESSAGE`). This stage exists in addition to the
 * translate-layer rewriter because Copilot's Anthropic Messages endpoint never
 * traverses the `anthropic-messages-via-*` translation pairs — the Copilot Anthropic Messages
 * substring set here (`Request body is too large...`) is disjoint from
 * the OpenAI Responses/OpenAI Chat Completions shapes those pairs match on.
 */
