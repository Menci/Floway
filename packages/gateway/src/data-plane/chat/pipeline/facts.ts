import type { ChatDelivery } from './delivery.ts';
import type { Candidate, GatewayRequestFacts, GatewayResponseFacts } from '../../pipeline/facts.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { factSpace } from '@floway-dev/pipeline';
import type { AnthropicMessagesResult } from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentResult } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsResultEx } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';
import type { ProtocolOutcome, UpstreamEvent, UpstreamRequestFacts } from '@floway-dev/upstream';

interface ChatResults {
  anthropicMessages: AnthropicMessagesResult;
  geminiGenerateContent: GeminiGenerateContentResult;
  openaiChatCompletions: OpenAIChatCompletionsResultEx;
  openaiResponses: OpenAIResponsesResultEx;
}

export type ChatOperation = keyof ChatResults;
export type ChatOutcome<Op extends ChatOperation> = ProtocolOutcome<UpstreamEvent<Op>, ChatResults[Op]>;

export type ChatAttemptTarget<Op extends ChatOperation> = Candidate & {
  readonly operation: ChatOperation;
  readonly payload: UpstreamRequestFacts[Op];
};

export type ChatRequestFacts = GatewayRequestFacts & {
  delivery: ChatDelivery;
  'chat.target': ChatOperation;
  'chat.modelExists': boolean;
  'ws.message': Record<string, unknown>;
  'ws.eventId': string;
  'ws.responseId': string;
} & { [Op in ChatOperation as `chat.targets.${Op}`]: readonly ChatAttemptTarget<Op>[] };

export type ChatResponseFacts = Omit<GatewayResponseFacts, ChatOperation> & {
  [Op in ChatOperation]: ChatOutcome<Op>;
};

export const chatEgressRequest = ['http', 'upstream', 'model', 'aliasRules'] as const;

export const chatBodyRequest = [
  ...chatEgressRequest,
  'serve.startedAt', 'delivery', 'requestedModel', 'chat.target',
  'ws.message?', 'ws.eventId?', 'ws.responseId?',
] as const;

type OptionalWebSocketFacts = 'ws.message' | 'ws.eventId' | 'ws.responseId';
type CommonBodyRequest = Exclude<typeof chatBodyRequest[number], `${string}?`>;

export type BodyRequest<Op extends ChatOperation> = Pick<ChatRequestFacts, CommonBodyRequest | Op>
  & Partial<Pick<ChatRequestFacts, OptionalWebSocketFacts>>;

export type BodyResponse<Op extends ChatOperation> = Pick<ChatResponseFacts, 'http' | Op>
  & Partial<Pick<ChatResponseFacts, 'usage' | 'usageModelKey'>>;

export const chatBodyResponse = ['http', 'usage?', 'usageModelKey?'] as const;

export const { defineStage, compose } = factSpace<ChatRequestFacts, ChatResponseFacts, GatewayServices>();
