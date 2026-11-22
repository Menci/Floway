import type { AnthropicMessagesRequestFacts } from '../../../../../src/data-plane/chat/anthropic-messages/stages/types.ts';
import { stubRouteCandidate } from '../../../../test-utils/chat-pipeline.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { FlagId } from '@floway-dev/provider';

export const anthropicPayload = (overrides: Partial<AnthropicMessagesPayload> = {}): AnthropicMessagesPayload => ({
  model: 'resolved-model',
  max_tokens: 32,
  messages: [{ role: 'user', content: 'hello' }],
  ...overrides,
});

export const anthropicFacts = (
  payload: AnthropicMessagesPayload = anthropicPayload(),
  options: {
    readonly enabledFlags?: Iterable<FlagId>;
    readonly targetApi?: AnthropicMessagesRequestFacts['route.targetApi'];
    readonly headers?: AnthropicMessagesRequestFacts['request.inboundHeaders'];
    readonly anthropicBeta?: readonly string[];
  } = {},
): AnthropicMessagesRequestFacts => ({
  'route.candidate': stubRouteCandidate({ enabledFlags: options.enabledFlags }),
  'route.targetApi': options.targetApi ?? 'anthropicMessages',
  'request.inboundHeaders': options.headers ?? [],
  'request.payload': payload,
  'request.anthropicBeta': options.anthropicBeta ?? [],
  'web-search.state': undefined,
});
