import { inputErrorEnvelope } from './errors.ts';
import { OPENAI_RESPONSES_STREAMED_USAGE, type Fields } from './facts.ts';
import { standaloneToolOutputContent } from './items/standalone-tool-output-content.ts';
import { openaiResponsesTarget } from './target.ts';
import { upstreamPerformanceContext } from '../../shared/telemetry/attribution.ts';
import type { Chat } from '../facts.ts';
import type { ChatServices } from '../services.ts';
import { tryCatchChatServeFailure, type InputErrorDetails } from '../shared/errors.ts';
import { defineStage, move } from '@floway-dev/pipeline';

type Refusal = Fields<'response.chat.openaiResponses' | 'response.chat.openaiResponses.streamedUsage'
  | 'response.usage.billable' | 'response.http.headers' | 'response.http.body' | 'response.http.status'>;

// Codex sends external context as function outputs without a call ID. OpenAI
// accepts them, but other protocols need a user message to carry that context.
// https://github.com/openai/codex/blob/8011b92bc82d4cc1b6dc3f35c0cd28768c797c97/codex-rs/context-fragments/src/additional_context.rs#L35-L46
// https://github.com/openai/codex/issues/42088
export const lowerOpenAIResponsesStandaloneToolOutputs = defineStage<
  Chat<'request.chat.openaiResponses' | 'route.attempt'>,
  Chat<'request.chat.openaiResponses' | 'route.attempt'>,
  Chat<'response.chat.openaiResponses'>,
  Chat<'response.chat.openaiResponses'>,
  Refusal,
  ChatServices
>({
  name: 'lowerOpenAIResponsesStandaloneToolOutputs',
  through: {
    request: { needs: ['request.chat.openaiResponses', 'route.attempt'], consumes: [], provides: ['request.chat.openaiResponses'] },
    response: { needs: ['response.chat.openaiResponses'], consumes: [], provides: [] },
  },
  return: { provides: ['response.chat.openaiResponses', OPENAI_RESPONSES_STREAMED_USAGE, 'response.usage.billable', 'response.http.headers', 'response.http.body', 'response.http.status'] },
  execute: async (facts, next, use) => {
    const payload = facts['request.chat.openaiResponses'];
    if (!payload.input.some(item => item.type === 'function_call_output' && item.call_id == null)) return await next(facts);
    const attempt = facts['route.attempt'];
    const candidate = use.resolveAttempt(attempt);
    const native = openaiResponsesTarget.pick(candidate.model.endpoints) === 'openaiResponses';
    if (native && !attempt.flags.includes('openai-responses-standalone-tool-output-shim')) return await next(facts);

    let input;
    try {
      input = payload.input.map((item, index) => item.type === 'function_call_output' && item.call_id == null
        ? { type: 'message' as const, role: 'user' as const, content: standaloneToolOutputContent(item, index) }
        : item);
    } catch (error) {
      const failure = tryCatchChatServeFailure<InputErrorDetails & { readonly kind: 'invalid-input' }>(error);
      if (failure === null) throw error;
      use.gateway.attempt.telemetry = upstreamPerformanceContext(use.gateway, candidate, 'chat');
      return move({
        ...facts,
        'response.chat.openaiResponses': { status: 400, message: failure.message, envelope: inputErrorEnvelope(failure) },
        [OPENAI_RESPONSES_STREAMED_USAGE]: null,
        'response.usage.billable': [],
        'response.http.headers': [],
        'response.http.body': null,
        'response.http.status': 400,
      }) as never;
    }
    return await next({ ...facts, 'request.chat.openaiResponses': move({ ...payload, input }) });
  },
});
