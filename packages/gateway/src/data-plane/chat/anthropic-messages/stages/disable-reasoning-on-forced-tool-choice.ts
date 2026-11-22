import type { AnthropicMessagesRequestFacts } from './types.ts';
import type { ChatPipelineServices } from '../../pipeline/index.ts';
import { defineRequestStage } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { hasEnabledFlag } from '@floway-dev/provider';

const disableReasoning = (payload: AnthropicMessagesPayload): AnthropicMessagesPayload => {
  const { output_config, ...rest } = payload;
  const next: AnthropicMessagesPayload = { ...rest, thinking: { type: 'disabled' } };
  if (output_config !== undefined) {
    const { effort: _effort, ...remaining } = output_config;
    if (Object.keys(remaining).length > 0) next.output_config = remaining;
  }
  return next;
};

export const disableReasoningOnForcedToolChoice = defineRequestStage<
  AnthropicMessagesRequestFacts,
  Pick<AnthropicMessagesRequestFacts, 'request.payload'>,
  never,
  ChatPipelineServices
>({
  name: 'disableReasoningOnForcedToolChoice',
  provides: ['request.payload'],
  execute: async (facts, next) => {
    const payload = facts['request.payload'];
    const choice = payload.tool_choice?.type;
    if (!hasEnabledFlag(facts['route.candidate'].providerModel, 'disable-reasoning-on-forced-tool-choice')
      || (choice !== 'tool' && choice !== 'any')) return await next({ 'request.payload': payload });
    return await next({ 'request.payload': disableReasoning(payload) });
  },
});
