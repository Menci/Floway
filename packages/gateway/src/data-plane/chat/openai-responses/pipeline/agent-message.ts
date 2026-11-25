import { openAIResponsesInputError } from './error.ts';
import { openAIResponsesTargetFor } from './target.ts';
import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { tryCatchChatServeFailure, type InputErrorDetails } from '../../shared/errors.ts';
import { agentMessageContent } from '../items/agent-message-content.ts';
import { move } from '@floway-dev/pipeline';

const { defineStage } = gatewayFactSpace<{}>();

// Codex agent messages need a framed user message on targets without the
// dedicated item type. The frame preserves the source's lack of user authority.
// https://github.com/openai/codex/blob/0a2eb4696c26ac33204bcd255721ab30220a4774/codex-rs/protocol/src/models.rs#L1036-L1046
export const lowerOpenAIResponsesAgentMessage = defineStage({
  name: 'openaiResponses.agent-message',
  through: {
    request: { needs: ['request.openaiResponses', 'serve.candidate'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: ['response.http', 'response.openaiResponses'], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.openaiResponses'] },
  async execute(facts, scope) {
    const candidate = facts['serve.candidate'];
    const payload = facts['request.openaiResponses'];
    if (openAIResponsesTargetFor(candidate) === 'openaiResponses'
      && !candidate.model.enabledFlags.includes('openai-responses-agent-message-shim')) return await scope.next(facts);
    if (!payload.input.some(item => item.type === 'agent_message')) return await scope.next(facts);

    let input: typeof payload.input;
    try {
      input = payload.input.map(item => item.type === 'agent_message'
        ? { type: 'message', role: 'user', content: agentMessageContent(item) }
        : item);
    } catch (error) {
      const failure = tryCatchChatServeFailure<InputErrorDetails & { readonly kind: 'invalid-input' }>(error);
      if (failure === null) throw error;
      return openAIResponsesInputError(failure);
    }
    return await scope.next({ ...facts, 'request.openaiResponses': move({ ...payload, input }) });
  },
});
