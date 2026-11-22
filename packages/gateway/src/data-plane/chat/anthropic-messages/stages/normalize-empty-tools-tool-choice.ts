import type { AnthropicMessagesRequestFacts } from './types.ts';
import type { ChatPipelineServices } from '../../pipeline/index.ts';
import { defineRequestStage } from '@floway-dev/pipeline';
import { hasEnabledFlag } from '@floway-dev/provider';

export const normalizeEmptyToolsToolChoice = defineRequestStage<
  AnthropicMessagesRequestFacts,
  Pick<AnthropicMessagesRequestFacts, 'request.payload'>,
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
      || payload.tool_choice?.type === 'none') return await next({ 'request.payload': payload });
    return await next({ 'request.payload': { ...payload, tool_choice: { type: 'none' } } });
  },
});
