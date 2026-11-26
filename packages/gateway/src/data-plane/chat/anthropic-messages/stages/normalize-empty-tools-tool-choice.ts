import { anthropicMessagesPayloadStage } from './payload-stage.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

// Opt-in compatibility rewrite for upstreams that reject an active
// `tool_choice` when the caller explicitly supplies no tools. Anthropic Messages uses
// an object for its native no-tool choice.
export const normalizeAnthropicMessagesEmptyToolsToolChoice = <Payload extends Pick<AnthropicMessagesPayload, 'tools' | 'tool_choice'>>(payload: Payload): Payload =>
  Array.isArray(payload.tools) && payload.tools.length === 0 ? { ...payload, tool_choice: { type: 'none' } } : payload;

export const normalizeEmptyToolsToolChoice = anthropicMessagesPayloadStage('normalize-empty-tools-tool-choice', (payload, flags) =>
  flags.includes('empty-tools-tool-choice-none') ? normalizeAnthropicMessagesEmptyToolsToolChoice(payload) : payload);
