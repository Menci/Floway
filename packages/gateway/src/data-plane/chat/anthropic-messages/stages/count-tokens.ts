import { nativeDispatchPlan } from './dispatch-plan.ts';
import type { AnthropicMessagesPreparedFacts } from './types.ts';
import { plainOutcomeFromHttpOutcome } from '../../pipeline/index.ts';
import type { ChatPipelineServices } from '../../pipeline/index.ts';
import { defineStage } from '@floway-dev/pipeline';
import type { HttpOutcome } from '@floway-dev/provider';

export const countTokensNative = defineStage<
  AnthropicMessagesPreparedFacts,
  { readonly 'dispatch.plan': Extract<import('./types.ts').AnthropicMessagesDispatchPlan, { type: 'native' }> },
  HttpOutcome,
  import('../../pipeline/index.ts').ChatPlainOutcome,
  never,
  ChatPipelineServices
>({
  name: 'countTokensNative',
  provides: ['dispatch.plan'],
  execute: async (facts, next, env) => {
    const candidate = facts['route.candidate'];
    const http = await next({
      'dispatch.plan': nativeDispatchPlan(facts, env),
    });
    return await plainOutcomeFromHttpOutcome(http, candidate.upstreamId);
  },
});
