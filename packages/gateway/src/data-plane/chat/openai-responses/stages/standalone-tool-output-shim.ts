import type { OpenAIResponsesStageFacts, OpenAIResponsesStageOutcome } from './facts.ts';
import { routeCandidatePerformanceContext } from '../../../pipeline/failover.ts';
import { openAiErrorChatOutcome, type ChatPipelineServices } from '../../pipeline/index.ts';
import { tryCatchChatServeFailure, type InputErrorDetails } from '../../shared/errors.ts';
import { standaloneToolOutputContent } from '../items/standalone-tool-output-content.ts';
import { defineStage } from '@floway-dev/pipeline';
import { hasEnabledFlag } from '@floway-dev/provider';

// Codex injects client context as `function_call_output` items without a
// `call_id`. Strict Responses-compatible upstreams reject them and translators
// cannot express a tool result that answers no call.
// https://github.com/openai/codex/blob/8011b92bc82d4cc1b6dc3f35c0cd28768c797c97/codex-rs/context-fragments/src/additional_context.rs#L35-L46
// https://github.com/openai/codex/issues/42088
export const standaloneToolOutputShim = defineStage<
  OpenAIResponsesStageFacts,
  Pick<OpenAIResponsesStageFacts, 'request.payload'>,
  OpenAIResponsesStageOutcome,
  OpenAIResponsesStageOutcome,
  never,
  ChatPipelineServices
>({
  name: 'standaloneToolOutputShim',
  provides: ['request.payload'],
  execute: async (facts, next, env) => {
    const candidate = facts['route.candidate'];
    if (facts['route.targetApi'] === 'openaiResponses'
      && !hasEnabledFlag(candidate.providerModel, 'openai-responses-standalone-tool-output-shim')) {
      return await next({ 'request.payload': facts['request.payload'] });
    }
    const payload = facts['request.payload'];
    if (!payload.input.some(item => item.type === 'function_call_output' && item.call_id == null)) {
      return await next({ 'request.payload': payload });
    }

    try {
      return await next({
        'request.payload': {
          ...payload,
          input: payload.input.map((item, index) => item.type === 'function_call_output' && item.call_id == null
            ? { type: 'message', role: 'user', content: standaloneToolOutputContent(item, index) }
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
