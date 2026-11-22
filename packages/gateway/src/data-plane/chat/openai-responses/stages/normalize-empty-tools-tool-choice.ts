import type { OpenAIResponsesStageFacts, OpenAIResponsesStageOutcome } from './facts.ts';
import type { ChatPipelineServices } from '../../pipeline/index.ts';
import { defineStage } from '@floway-dev/pipeline';
import { collectOpenAIResponsesTools } from '@floway-dev/protocols/openai-responses';
import { hasEnabledFlag } from '@floway-dev/provider';

// Compatibility rewrite for upstreams that reject an active `tool_choice`
// when no tools are available after server-tool preparation.
export const normalizeEmptyToolsToolChoice = defineStage<
  OpenAIResponsesStageFacts,
  Pick<OpenAIResponsesStageFacts, 'request.payload'>,
  OpenAIResponsesStageOutcome,
  OpenAIResponsesStageOutcome,
  never,
  ChatPipelineServices
>({
  name: 'normalizeEmptyToolsToolChoice',
  provides: ['request.payload'],
  execute: async (facts, next) => {
    const payload = facts['request.payload'];
    if (!hasEnabledFlag(facts['route.candidate'].providerModel, 'empty-tools-tool-choice-none')
      || !Array.isArray(payload.tools)
      || payload.tools.length !== 0
      || collectOpenAIResponsesTools(payload).length !== 0) {
      return await next({ 'request.payload': payload });
    }
    return await next({ 'request.payload': { ...payload, tool_choice: 'none' } });
  },
});
