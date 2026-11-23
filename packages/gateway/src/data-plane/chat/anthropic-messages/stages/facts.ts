import type { RouteCandidate } from '../../../pipeline/services.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ChatTargetApi } from '@floway-dev/provider';

export interface AnthropicMessagesRequest {
  readonly 'request.anthropicMessages': AnthropicMessagesPayload;
}

export type AnthropicMessagesFrame = ProtocolFrame<AnthropicMessagesStreamEventEx>;

export interface AnthropicMessagesCandidateRequest extends AnthropicMessagesRequest {
  readonly 'route.candidate': RouteCandidate;
}

export interface AnthropicMessagesTargetRequest extends AnthropicMessagesCandidateRequest {
  readonly 'route.targetApi': ChatTargetApi;
}
