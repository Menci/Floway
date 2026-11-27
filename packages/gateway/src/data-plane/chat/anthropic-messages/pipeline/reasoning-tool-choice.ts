import { defineStage } from '../../pipeline/facts.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

export const disableAnthropicMessagesReasoningOnForcedToolChoice = <Payload extends Pick<AnthropicMessagesPayload, 'tool_choice' | 'thinking' | 'output_config'>>(
  payload: Payload,
): Payload => {
  const choice = payload.tool_choice?.type;
  if (choice !== 'tool' && choice !== 'any') return payload;
  const next = { ...payload, thinking: { type: 'disabled' as const } };
  delete next.output_config;
  if (payload.output_config != null) {
    const { effort: _effort, ...remaining } = payload.output_config;
    if (Object.keys(remaining).length > 0) next.output_config = remaining;
  }
  return next;
};

export const disableAnthropicMessagesForcedToolReasoning = defineStage({
  name: 'anthropicMessages.disable-reasoning-on-forced-tool-choice',
  through: {
    request: { needs: ['anthropicMessages', 'model'], provides: ['anthropicMessages'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    if (!facts.model.enabledFlags.includes('disable-reasoning-on-forced-tool-choice')) return await scope.next(facts);
    const payload = disableAnthropicMessagesReasoningOnForcedToolChoice(facts.anthropicMessages);
    return await scope.next({ ...facts, anthropicMessages: payload });
  },
});
