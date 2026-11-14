import { inputErrorEnvelope } from './errors.ts';
import { OPENAI_RESPONSES_STREAMED_USAGE, type Fields } from './facts.ts';
import { agentMessageContent } from './items/agent-message-content.ts';
import { openaiResponsesTarget } from './target.ts';
import { upstreamPerformanceContext } from '../../shared/telemetry/attribution.ts';
import type { Chat } from '../facts.ts';
import type { ChatServices } from '../services.ts';
import { tryCatchChatServeFailure, type InputErrorDetails } from '../shared/errors.ts';
import { defineStage, move } from '@floway-dev/pipeline';

type Refusal = Fields<'response.chat.openaiResponses' | 'response.chat.openaiResponses.streamedUsage' | 'response.usage.billable' | 'response.http.headers' | 'response.http.body' | 'response.http.status'>;

/**
 * Codex delivers sub-agent tasks and inter-agent messages as `agent_message` input items.
 * Only a native OpenAI Responses upstream can understand the item, and some
 * Responses-compatible upstreams drop or reject it, so a spawned sub-agent never sees its
 * task. Each item becomes a user message whose content frames the payload as coming from
 * another agent, keeping the user-role wire slot from granting user authority.
 *
 * The lowering is mandatory when the candidate's target protocol is not OpenAI Responses (the
 * translators do not know the item) and opt-in through `openai-responses-agent-message-shim`
 * on a native target, which otherwise receives the item untouched.
 * https://github.com/openai/codex/blob/0a2eb4696c26ac33204bcd255721ab30220a4774/codex-rs/protocol/src/models.rs#L1036-L1046
 */
export const lowerOpenAIResponsesAgentMessages = defineStage<
  Chat<'request.chat.openaiResponses' | 'route.attempt'>,
  Chat<'request.chat.openaiResponses' | 'route.attempt'>,
  Chat<'response.chat.openaiResponses'>,
  Chat<'response.chat.openaiResponses'>,
  Refusal,
  ChatServices
>({
  name: 'lowerOpenAIResponsesAgentMessages',
  through: {
    request: { needs: ['request.chat.openaiResponses', 'route.attempt'], consumes: [], provides: ['request.chat.openaiResponses'] },
    response: { needs: ['response.chat.openaiResponses'], consumes: [], provides: [] },
  },
  return: { provides: ['response.chat.openaiResponses', OPENAI_RESPONSES_STREAMED_USAGE, 'response.usage.billable', 'response.http.headers', 'response.http.body', 'response.http.status'] },
  execute: async (facts, next, use) => {
    const payload = facts['request.chat.openaiResponses'];
    if (!payload.input.some(item => item.type === 'agent_message')) return await next(facts);
    const attempt = facts['route.attempt'];
    const native = openaiResponsesTarget.pick(use.resolveAttempt(attempt).model.endpoints) === 'openaiResponses';
    if (native && !attempt.flags.includes('openai-responses-agent-message-shim')) return await next(facts);

    let input;
    try {
      input = payload.input.map(item => item.type === 'agent_message'
        ? { type: 'message' as const, role: 'user' as const, content: agentMessageContent(item) }
        : item);
    } catch (error) {
      const failure = tryCatchChatServeFailure<InputErrorDetails & { readonly kind: 'invalid-input' }>(error);
      if (failure === null) throw error;
      use.gateway.attempt.telemetry = upstreamPerformanceContext(use.gateway, use.resolveAttempt(attempt), 'chat');
      // Nothing was dialled, so nothing is billable and nothing is still streaming.
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
