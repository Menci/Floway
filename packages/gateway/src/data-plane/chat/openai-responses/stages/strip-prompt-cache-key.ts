import type { OpenAIResponsesStageFacts, OpenAIResponsesStageOutcome } from './facts.ts';
import type { ChatPipelineServices } from '../../pipeline/index.ts';
import { defineStage } from '@floway-dev/pipeline';
import { hasEnabledFlag } from '@floway-dev/provider';

// Some upstreams reject `prompt_cache_key` as an unknown argument.
export const stripPromptCacheKey = defineStage<
  OpenAIResponsesStageFacts,
  Pick<OpenAIResponsesStageFacts, 'request.payload'>,
  OpenAIResponsesStageOutcome,
  OpenAIResponsesStageOutcome,
  never,
  ChatPipelineServices
>({
  name: 'stripPromptCacheKey',
  provides: ['request.payload'],
  execute: async (facts, next) => {
    if (!hasEnabledFlag(facts['route.candidate'].providerModel, 'strip-prompt-cache-key')
      || facts['request.payload'].prompt_cache_key === undefined) {
      return await next({ 'request.payload': facts['request.payload'] });
    }
    const { prompt_cache_key: _stripped, ...payload } = facts['request.payload'];
    return await next({ 'request.payload': payload });
  },
});
