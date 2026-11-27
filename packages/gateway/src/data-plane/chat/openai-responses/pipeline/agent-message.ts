import { openAIResponsesLocalError } from './local-error.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { agentMessageContent } from '../items/agent-message-content.ts';
import { OpenAIResponsesInvalidInputError } from '../items/invalid-input.ts';
import type { CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

// https://github.com/openai/codex/blob/0a2eb4696c26ac33204bcd255721ab30220a4774/codex-rs/protocol/src/models.rs#L1036-L1046
export const lowerOpenAIResponsesAgentInput = (input: CanonicalOpenAIResponsesInputItem[]) => {
  if (!input.some(item => item.type === 'agent_message')) return { input };
  try {
    return {
      input: input.map((item): CanonicalOpenAIResponsesInputItem =>
        item.type === 'agent_message' ? { type: 'message', role: 'user', content: agentMessageContent(item) } : item),
    };
  } catch (error) {
    if (!(error instanceof OpenAIResponsesInvalidInputError)) throw error;
    return { failure: error };
  }
};

export const lowerOpenAIResponsesAgentMessage = defineStage({
  name: 'openaiResponses.lower-agent-message',
  through: {
    request: { needs: ['openaiResponses', 'model', 'chat.target'], provides: ['openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http', 'openaiResponses'] },
  async execute(facts, scope) {
    if (facts['chat.target'] === 'openaiResponses' && !facts.model.enabledFlags.includes('openai-responses-agent-message-shim')) return await scope.next(facts);
    const payload = facts.openaiResponses;
    const lowered = lowerOpenAIResponsesAgentInput(payload.input);
    if ('failure' in lowered) return openAIResponsesLocalError(400, lowered.failure.message, lowered.failure);
    if (lowered.input === payload.input) return await scope.next(facts);
    return await scope.next({ ...facts, openaiResponses: { ...payload, input: lowered.input } });
  },
});
