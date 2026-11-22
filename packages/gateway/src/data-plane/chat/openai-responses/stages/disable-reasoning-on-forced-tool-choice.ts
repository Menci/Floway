import type { OpenAIResponsesStageFacts, OpenAIResponsesStageOutcome } from './facts.ts';
import type { ChatPipelineServices } from '../../pipeline/index.ts';
import { defineStage } from '@floway-dev/pipeline';
import type { OpenAIResponsesPayloadEx } from '@floway-dev/protocols/openai-responses';
import { hasEnabledFlag } from '@floway-dev/provider';

const hasForcedToolChoice = (payload: OpenAIResponsesPayloadEx): boolean => {
  const choice = payload.tool_choice;
  if (choice === undefined || choice === null) return false;
  return typeof choice === 'string' ? choice === 'required' : true;
};

// Opt-in workaround for upstreams where forced `tool_choice` and reasoning do
// not compose. Vendor normalizers translate this canonical sentinel.
export const disableReasoningOnForcedToolChoice = defineStage<
  OpenAIResponsesStageFacts,
  Pick<OpenAIResponsesStageFacts, 'request.payload'>,
  OpenAIResponsesStageOutcome,
  OpenAIResponsesStageOutcome,
  never,
  ChatPipelineServices
>({
  name: 'disableReasoningOnForcedToolChoice',
  provides: ['request.payload'],
  execute: async (facts, next) => {
    const candidate = facts['route.candidate'];
    if (!hasEnabledFlag(candidate.providerModel, 'disable-reasoning-on-forced-tool-choice')
      || !hasForcedToolChoice(facts['request.payload'])) {
      return await next({ 'request.payload': facts['request.payload'] });
    }
    return await next({ 'request.payload': { ...facts['request.payload'], reasoning: { effort: 'none' } } });
  },
});
