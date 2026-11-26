import { openAIResponsesInputError } from './errors.ts';
import { agentMessageContent } from './items/agent-message-content.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { tryCatchChatServeFailure, type InputErrorDetails } from '../shared/errors.ts';
import type { CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

// Translators express the Codex agent_message as a framed user message.
// https://github.com/openai/codex/blob/0a2eb4696c26ac33204bcd255721ab30220a4774/codex-rs/protocol/src/models.rs#L1036-L1046
export const lowerOpenAIResponsesAgentMessage = defineStage({
  name: 'openaiResponses.lower-agent-message',
  through: {
    request: { needs: ['request.openaiResponses', 'provider.model'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.openaiResponses'] },
  async execute(facts, scope) {
    const model = facts['provider.model'];
    const payload = facts['request.openaiResponses'];
    if (model.endpoints.openaiResponses !== undefined && !model.enabledFlags.includes('openai-responses-agent-message-shim')) return await scope.next(facts);
    const lowered = lowerOpenAIResponsesAgentInput(payload.input);
    if ('failure' in lowered) return openAIResponsesInputError(lowered.failure);
    if (lowered.input === payload.input) return await scope.next(facts);
    return await scope.next({ ...facts, 'request.openaiResponses': { ...payload, input: lowered.input } });
  },
});

export const lowerOpenAIResponsesAgentInput = (input: CanonicalOpenAIResponsesInputItem[]) => {
  if (!input.some(item => item.type === 'agent_message')) return { input };
  try {
    return {
      input: input.map((item): CanonicalOpenAIResponsesInputItem => item.type === 'agent_message'
        ? { type: 'message', role: 'user', content: agentMessageContent(item) }
        : item),
    };
  } catch (error) {
    const failure = tryCatchChatServeFailure<InputErrorDetails & { kind: 'invalid-input' }>(error);
    if (failure === null) throw error;
    return { failure };
  }
};
