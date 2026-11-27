import { defineStage } from '../../pipeline/facts.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

export const normalizeAnthropicMessagesEmptyToolsToolChoice = <Payload extends Pick<AnthropicMessagesPayload, 'tools' | 'tool_choice'>>(
  payload: Payload,
): Payload => Array.isArray(payload.tools) && payload.tools.length === 0 ? { ...payload, tool_choice: { type: 'none' } } : payload;

export const normalizeAnthropicMessagesToolChoice = defineStage({
  name: 'anthropicMessages.normalize-empty-tools-tool-choice',
  through: {
    request: { needs: ['anthropicMessages', 'model'], provides: ['anthropicMessages'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    if (!facts.model.enabledFlags.includes('empty-tools-tool-choice-none')) return await scope.next(facts);
    const payload = normalizeAnthropicMessagesEmptyToolsToolChoice(facts.anthropicMessages);
    return await scope.next({ ...facts, anthropicMessages: payload });
  },
});
