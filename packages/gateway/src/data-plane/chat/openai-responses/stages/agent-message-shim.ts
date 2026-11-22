import type { OpenAIResponsesStageFacts, OpenAIResponsesStageOutcome } from './facts.ts';
import { routeCandidatePerformanceContext } from '../../../pipeline/failover.ts';
import { openAiErrorChatOutcome, type ChatPipelineServices } from '../../pipeline/index.ts';
import { tryCatchChatServeFailure, type InputErrorDetails } from '../../shared/errors.ts';
import { agentMessageContent } from '../items/agent-message-content.ts';
import { defineStage } from '@floway-dev/pipeline';
import { hasEnabledFlag } from '@floway-dev/provider';

// Codex delivers sub-agent tasks and inter-agent messages as `agent_message`
// input items. Native Responses-compatible upstreams frequently reject or
// ignore the item, so lowering is mandatory across translation and opt-in on
// a native target.
// https://github.com/openai/codex/blob/0a2eb4696c26ac33204bcd255721ab30220a4774/codex-rs/protocol/src/models.rs#L1036-L1046
export const agentMessageShim = defineStage<
  OpenAIResponsesStageFacts,
  Pick<OpenAIResponsesStageFacts, 'request.payload'>,
  OpenAIResponsesStageOutcome,
  OpenAIResponsesStageOutcome,
  never,
  ChatPipelineServices
>({
  name: 'agentMessageShim',
  provides: ['request.payload'],
  execute: async (facts, next, env) => {
    const candidate = facts['route.candidate'];
    if (facts['route.targetApi'] === 'openaiResponses'
      && !hasEnabledFlag(candidate.providerModel, 'openai-responses-agent-message-shim')) {
      return await next({ 'request.payload': facts['request.payload'] });
    }
    const payload = facts['request.payload'];
    if (!payload.input.some(item => item.type === 'agent_message')) return await next({ 'request.payload': payload });

    try {
      return await next({
        'request.payload': {
          ...payload,
          input: payload.input.map(item => item.type === 'agent_message'
            ? { type: 'message', role: 'user', content: agentMessageContent(item) }
            : item),
        },
      });
    } catch (error) {
      const failure = tryCatchChatServeFailure<InputErrorDetails & { readonly kind: 'invalid-input' }>(error);
      if (failure === null) throw error;
      return openAiErrorChatOutcome(
        400,
        failure.message,
        { param: failure.param ?? 'input', code: failure.code ?? null },
        routeCandidatePerformanceContext(env, candidate, 'chat'),
      );
    }
  },
});
