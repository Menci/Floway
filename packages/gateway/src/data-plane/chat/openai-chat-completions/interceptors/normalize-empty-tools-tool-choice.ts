import { openAIChatCompletionsPayloadStage } from './payload-stage.ts';

// Opt-in compatibility rewrite for upstreams that reject an active
// `tool_choice` when the caller explicitly supplies no tools. Keep `tools` as
// sent and make the caller's effective intent unambiguous on the target wire.
export const normalizeEmptyToolsToolChoice = openAIChatCompletionsPayloadStage('normalize-empty-tools-tool-choice', (payload, flags) =>
  flags.includes('empty-tools-tool-choice-none') && Array.isArray(payload.tools) && payload.tools.length === 0
    ? { ...payload, tool_choice: 'none' }
    : payload);
