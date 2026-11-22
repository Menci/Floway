import type { AnthropicMessagesAttemptInput, ChatAttemptOutcome, ChatPipelineServices } from '../../pipeline/index.ts';
import type { HeaderEntry, ManagedStream, StageEnv } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ChatTargetApi, RouteCandidate } from '@floway-dev/provider';

export interface AnthropicMessagesRequestFacts extends AnthropicMessagesAttemptInput {
  readonly 'route.targetApi': ChatTargetApi;
  readonly 'web-search.state': import('../web-search-shim.ts').AnthropicMessagesWebSearchShimState | undefined;
}

export type AnthropicMessagesPreparedFacts = AnthropicMessagesRequestFacts;

export type AnthropicMessagesDispatchPlan =
  | {
    readonly type: 'native';
    readonly targetApi: 'anthropicMessages';
    readonly candidate: RouteCandidate;
    readonly headers: readonly HeaderEntry[];
    readonly payload: Omit<AnthropicMessagesPayload, 'model'>;
  }
  | {
    readonly type: 'translated';
    readonly targetApi: 'openaiResponses';
    readonly candidate: RouteCandidate;
    readonly headers: readonly HeaderEntry[];
    readonly payload: import('@floway-dev/protocols/openai-responses').CanonicalOpenAIResponsesPayload;
  }
  | {
    readonly type: 'translated';
    readonly targetApi: 'openaiChatCompletions';
    readonly candidate: RouteCandidate;
    readonly headers: readonly HeaderEntry[];
    readonly payload: import('@floway-dev/protocols/openai-chat-completions').OpenAIChatCompletionsPayloadEx;
  };

export type AnthropicMessagesGenerateOutcome = ChatAttemptOutcome<AnthropicMessagesStreamEventEx>;

export type AnthropicMessagesDispatchedOutcome =
  | AnthropicMessagesGenerateOutcome
  | ChatAttemptOutcome<import('@floway-dev/protocols/openai-responses').OpenAIResponsesStreamEventEx>
  | ChatAttemptOutcome<import('@floway-dev/protocols/openai-chat-completions').OpenAIChatCompletionsStreamEvent>
  | import('@floway-dev/provider').ProviderPipelineStreamOutcome<AnthropicMessagesStreamEventEx>;

export type AnthropicMessagesFrames = ManagedStream<ProtocolFrame<AnthropicMessagesStreamEventEx>>;

export type AnthropicMessagesEnv = StageEnv<ChatPipelineServices>;
