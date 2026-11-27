import type { FlagId } from './flags.ts';
import type { UpstreamKind, UpstreamModel, UpstreamRecord } from './model.ts';
import type { HttpRequestFact, HttpResponseFact, HttpStreamError } from '@floway-dev/http';
import type { ManagedStream, Pipeline } from '@floway-dev/pipeline';
import type { AnthropicMessagesCountTokensPayload, AnthropicMessagesCountTokensResult, AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { JsonObject, ProtocolDecodeError } from '@floway-dev/protocols/common';
import type { CanonicalDecisionRequest, CanonicalDecisionResponse } from '@floway-dev/protocols/decision';
import type { GeminiGenerateContentCountTokensPayload, GeminiGenerateContentCountTokensResult, GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIAudioSpeechPayload, OpenAIAudioSpeechStreamEvent, OpenAIAudioTranscriptionStreamItem, OpenAIAudioTranscriptionsPayload } from '@floway-dev/protocols/openai-audio';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAICompletionsPayload, OpenAICompletionsResult, OpenAICompletionsStreamEvent } from '@floway-dev/protocols/openai-completions';
import type { OpenAIEmbeddingsPayload } from '@floway-dev/protocols/openai-embeddings';
import type { OpenAIImagesEditsPayload, OpenAIImagesGenerationsPayload, OpenAIImagesStreamItem } from '@floway-dev/protocols/openai-images';
import type { CanonicalOpenAIResponsesCompactPayload, CanonicalOpenAIResponsesPayload, OpenAIResponsesCompactionResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { CanonicalRerankRequest, CanonicalRerankResponse } from '@floway-dev/protocols/rerank';

export type ChatTargetApi = 'anthropicMessages' | 'geminiGenerateContent' | 'openaiResponses' | 'openaiChatCompletions';

export interface UpstreamSnapshot {
  readonly id: string;
  readonly kind: UpstreamKind;
  readonly name: string;
  readonly config: unknown;
}

export const toUpstreamSnapshot = ({ id, kind, name, config }: UpstreamRecord): UpstreamSnapshot => ({ id, kind, name, config });

export type UpstreamModelSnapshot = Readonly<Omit<UpstreamModel, 'enabledFlags' | 'flagOverrides'>> & {
  readonly enabledFlags: readonly FlagId[];
};

export const toUpstreamModelSnapshot = ({ enabledFlags, flagOverrides, ...model }: UpstreamModel): UpstreamModelSnapshot => ({
  ...model,
  enabledFlags: [...enabledFlags],
});

export type ProtocolStreamError = HttpStreamError | ProtocolDecodeError;

export interface ProtocolError<Body = unknown> {
  kind: 'error';
  source: 'upstream' | 'local';
  error: Body;
}

export interface ProtocolStream<Event> {
  kind: 'stream';
  stream: ManagedStream<Event, ProtocolStreamError>;
}

export interface ProtocolResult<Output> {
  kind: 'result';
  result: Output;
}

export type ProtocolOutcome<Event, Output> = ProtocolError
  | ([Event] extends [never] ? never : ProtocolStream<Event>)
  | ([Output] extends [never] ? never : ProtocolResult<Output>);

type Operation<Request, Event, Output> = { request: Request; event: Event; result: Output };

interface Operations {
  alphaSearch: Operation<JsonObject, never, Uint8Array | JsonObject>;
  anthropicMessages: Operation<AnthropicMessagesPayload, AnthropicMessagesStreamEventEx, never>;
  anthropicMessagesCountTokens: Operation<AnthropicMessagesCountTokensPayload, never, AnthropicMessagesCountTokensResult | null>;
  decision: Operation<CanonicalDecisionRequest, never, Uint8Array | CanonicalDecisionResponse>;
  geminiGenerateContent: Operation<GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent, never>;
  geminiGenerateContentCountTokens: Operation<GeminiGenerateContentCountTokensPayload, never, GeminiGenerateContentCountTokensResult | null>;
  openaiAudioSpeech: Operation<OpenAIAudioSpeechPayload, OpenAIAudioSpeechStreamEvent, Uint8Array>;
  openaiAudioTranscriptions: Operation<OpenAIAudioTranscriptionsPayload, OpenAIAudioTranscriptionStreamItem, Uint8Array>;
  openaiChatCompletions: Operation<OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent, never>;
  openaiCompletions: Operation<OpenAICompletionsPayload, OpenAICompletionsStreamEvent, OpenAICompletionsResult>;
  openaiEmbeddings: Operation<OpenAIEmbeddingsPayload, never, JsonObject>;
  openaiImagesEdits: Operation<OpenAIImagesEditsPayload, OpenAIImagesStreamItem, JsonObject>;
  openaiImagesGenerations: Operation<OpenAIImagesGenerationsPayload, OpenAIImagesStreamItem, JsonObject>;
  openaiResponses: Operation<CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx, never>;
  openaiResponsesCompact: Operation<CanonicalOpenAIResponsesCompactPayload, never, OpenAIResponsesCompactionResultEx>;
  rerank: Operation<CanonicalRerankRequest, never, Uint8Array | CanonicalRerankResponse>;
}

export type UpstreamOperation = keyof Operations;
export type UpstreamEvent<Op extends UpstreamOperation> = Operations[Op]['event'];
export type UpstreamResult<Op extends UpstreamOperation> = Operations[Op]['result'];
export type UpstreamOutcome<Op extends UpstreamOperation> = ProtocolOutcome<UpstreamEvent<Op>, UpstreamResult<Op>>;

export type UpstreamRequestFacts = {
  http: HttpRequestFact;
  upstream: UpstreamSnapshot;
  model: UpstreamModelSnapshot;
} & { [Op in UpstreamOperation]: Operations[Op]['request'] };

export type UpstreamResponseFacts = {
  http: HttpResponseFact | null;
  usageModelKey: string;
} & { [Op in UpstreamOperation]: UpstreamOutcome<Op> };

export type UpstreamRequest<Op extends UpstreamOperation> = Pick<UpstreamRequestFacts, 'http' | 'upstream' | 'model' | Op>;
export type UpstreamResponse<Op extends UpstreamOperation, Optional extends 'usageModelKey' = never> =
  Pick<UpstreamResponseFacts, 'http' | Op> & Partial<Pick<UpstreamResponseFacts, Optional>>;

export type UpstreamPipeline<Op extends UpstreamOperation, Services = object, Optional extends 'usageModelKey' = never> =
  Pipeline<UpstreamRequest<Op>, UpstreamResponse<Op, Optional>, Services>;
