import { openAIResponsesInputError } from './error.ts';
import { openAIResponsesTargetFor } from './target.ts';
import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { tryCatchChatServeFailure, type InputErrorDetails } from '../../shared/errors.ts';
import { standaloneToolOutputContent } from '../items/standalone-tool-output-content.ts';
import { move } from '@floway-dev/pipeline';

const { defineStage } = gatewayFactSpace<{}>();

// Codex injects client context as function outputs with no call_id. A
// translated tool result must answer a call, so the content travels as
// external context in a user message.
// https://github.com/openai/codex/blob/8011b92bc82d4cc1b6dc3f35c0cd28768c797c97/codex-rs/context-fragments/src/additional_context.rs#L35-L46
// https://github.com/openai/codex/issues/42088
export const lowerOpenAIResponsesStandaloneToolOutput = defineStage({
  name: 'openaiResponses.standalone-tool-output',
  through: {
    request: { needs: ['request.openaiResponses', 'serve.candidate'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: ['response.http', 'response.openaiResponses'], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.openaiResponses'] },
  async execute(facts, scope) {
    const candidate = facts['serve.candidate'];
    const payload = facts['request.openaiResponses'];
    if (openAIResponsesTargetFor(candidate) === 'openaiResponses'
      && !candidate.model.enabledFlags.includes('openai-responses-standalone-tool-output-shim')) return await scope.next(facts);
    if (!payload.input.some(item => item.type === 'function_call_output' && item.call_id == null)) return await scope.next(facts);

    let input: typeof payload.input;
    try {
      input = payload.input.map((item, index) => item.type === 'function_call_output' && item.call_id == null
        ? { type: 'message', role: 'user', content: standaloneToolOutputContent(item, index) }
        : item);
    } catch (error) {
      const failure = tryCatchChatServeFailure<InputErrorDetails & { readonly kind: 'invalid-input' }>(error);
      if (failure === null) throw error;
      return openAIResponsesInputError(failure);
    }
    return await scope.next({ ...facts, 'request.openaiResponses': move({ ...payload, input }) });
  },
});
