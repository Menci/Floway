import type { GatewayCtx } from '../../src/data-plane/shared/gateway-ctx.ts';
import type { ProviderPipelines, ProviderChatServices } from '@floway-dev/provider';
import { noopUpstreamCallOptions, stubChatProviderPipeline, type StubChatProviderCall } from '@floway-dev/test-utils';

type Calls = Partial<{
  callOpenAIChatCompletions: StubChatProviderCall<'openaiChatCompletions'>;
  callOpenAIResponses: StubChatProviderCall<'openaiResponses'>;
  callAnthropicMessages: StubChatProviderCall<'anthropicMessages'>;
  callAnthropicMessagesCountTokens: StubChatProviderCall<'anthropicMessagesCountTokens'>;
}>;

export const stubChatProviderPipelines = (calls: Calls): ProviderPipelines => ({
  ...(calls.callOpenAIChatCompletions === undefined ? {} : { openaiChatCompletions: stubChatProviderPipeline('openaiChatCompletions', calls.callOpenAIChatCompletions) }),
  ...(calls.callOpenAIResponses === undefined ? {} : {
    openaiResponses: stubChatProviderPipeline('openaiResponses', calls.callOpenAIResponses),
    openaiResponsesCompact: stubChatProviderPipeline('openaiResponsesCompact', calls.callOpenAIResponses),
  }),
  ...(calls.callAnthropicMessages === undefined ? {} : { anthropicMessages: stubChatProviderPipeline('anthropicMessages', calls.callAnthropicMessages) }),
  ...(calls.callAnthropicMessagesCountTokens === undefined ? {} : { anthropicMessagesCountTokens: stubChatProviderPipeline('anthropicMessagesCountTokens', calls.callAnthropicMessagesCountTokens) }),
});

export const chatFixtureHttpServices = (gateway: GatewayCtx): ProviderChatServices => ({
  httpCall: () => ({ ...noopUpstreamCallOptions(), signal: gateway.abortSignal }),
  recordProtocolFrames: frames => frames,
});
