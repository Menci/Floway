import type { ChatAttemptOutcome, ChatPipelineServices, OpenAIChatCompletionsAttemptInput } from '../../pipeline/index.ts';
import { defineStage } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { hasEnabledFlag, type ChatTargetApi } from '@floway-dev/provider';

interface Facts extends OpenAIChatCompletionsAttemptInput {
  readonly 'route.targetApi': ChatTargetApi;
}

const hasForcedToolChoice = (payload: OpenAIChatCompletionsPayloadEx): boolean => {
  const choice = payload.tool_choice;
  if (choice === undefined || choice === null) return false;
  return typeof choice === 'string' ? choice === 'required' : true;
};

// Opt-in workaround for upstreams where forced `tool_choice` and enabled
// reasoning do not compose. Vendor normalizers translate this canonical sentinel
// into their wire form.
export const disableReasoningOnForcedToolChoice = defineStage<
  Facts,
  Pick<Facts, 'request.payload'>,
  ChatAttemptOutcome<OpenAIChatCompletionsStreamEvent>,
  ChatAttemptOutcome<OpenAIChatCompletionsStreamEvent>,
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
    return await next({
      'request.payload': { ...facts['request.payload'], reasoning_effort: 'none' },
    });
  },
});
