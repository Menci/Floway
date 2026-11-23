import type { RouteCandidate } from '../../../pipeline/services.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

export interface AnthropicMessagesRequest {
  readonly 'request.anthropicMessages': AnthropicMessagesPayload;
}

export type AnthropicMessagesFrame = ProtocolFrame<AnthropicMessagesStreamEventEx>;

export interface AnthropicMessagesCandidateRequest extends AnthropicMessagesRequest {
  readonly 'route.candidate': RouteCandidate;
}
