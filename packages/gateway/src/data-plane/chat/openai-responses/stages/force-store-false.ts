import type { OpenAIResponsesStageFacts, OpenAIResponsesStageOutcome } from './facts.ts';
import type { ChatPipelineServices } from '../../pipeline/index.ts';
import { defineStage } from '@floway-dev/pipeline';
import { hasEnabledFlag } from '@floway-dev/provider';

export const forceStoreFalse = defineStage<
  OpenAIResponsesStageFacts,
  Pick<OpenAIResponsesStageFacts, 'request.payload'>,
  OpenAIResponsesStageOutcome,
  OpenAIResponsesStageOutcome,
  never,
  ChatPipelineServices
>({
  name: 'forceStoreFalse',
  provides: ['request.payload'],
  execute: async (facts, next) => {
    if (!hasEnabledFlag(facts['route.candidate'].providerModel, 'openai-responses-store-false')) {
      return await next({ 'request.payload': facts['request.payload'] });
    }
    return await next({ 'request.payload': { ...facts['request.payload'], store: false } });
  },
});
