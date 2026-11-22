import type { AnthropicMessagesRequestFacts } from './types.ts';
import type { ChatTargetApi } from '@floway-dev/provider';

interface PreparedAnthropicMessagesKeys {
  readonly 'request.payload': AnthropicMessagesRequestFacts['request.payload'];
  readonly 'request.inboundHeaders': AnthropicMessagesRequestFacts['request.inboundHeaders'];
  readonly 'route.targetApi': ChatTargetApi;
}

export const prepareAnthropicMessagesRequest = (
  facts: import('../../pipeline/index.ts').AnthropicMessagesAttemptInput,
  targetApi: ChatTargetApi,
): PreparedAnthropicMessagesKeys => ({
  'request.payload': { ...facts['request.payload'], model: facts['route.candidate'].modelId },
  'request.inboundHeaders': Object.freeze(
    facts['request.inboundHeaders'].filter(([name]) => name.toLowerCase() !== 'anthropic-beta'),
  ),
  'route.targetApi': targetApi,
});
