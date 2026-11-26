import type { FlagId } from './flags.ts';
import type { OpenAIImagesEditsSource } from './images.ts';
import type { ProviderModel, UpstreamProviderKind } from './model.ts';
import type { HttpRequestFact, HttpResponseFact, HttpStreamError, ProviderFetcher } from '@floway-dev/http';
import type { ManagedStream, Pipeline } from '@floway-dev/pipeline';
import type { AnthropicMessagesCountTokensResult, AnthropicMessagesPayload, AnthropicMessagesResult, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { JsonObject, ProtocolDecodeError } from '@floway-dev/protocols/common';
import type { CanonicalDecisionRequest, CanonicalDecisionResponse } from '@floway-dev/protocols/decision';
import type { GeminiCountTokensPayload, GeminiGenerateContentCountTokensResult, GeminiGenerateContentPayload, GeminiGenerateContentResult, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIAudioSpeechPayload, OpenAIAudioSpeechStreamEvent, OpenAIAudioTranscriptionStreamItem } from '@floway-dev/protocols/openai-audio';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsResultEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAICompletionsPayload, OpenAICompletionsResult, OpenAICompletionsStreamEvent } from '@floway-dev/protocols/openai-completions';
import type { OpenAIEmbeddingsPayload } from '@floway-dev/protocols/openai-embeddings';
import type { OpenAIImagesGenerationsPayload, OpenAIImagesStreamEvent } from '@floway-dev/protocols/openai-images';
import type { CanonicalOpenAIResponsesCompactPayload, CanonicalOpenAIResponsesPayload, OpenAIResponsesCompactionResultEx, OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { CanonicalRerankRequest, CanonicalRerankResponse } from '@floway-dev/protocols/rerank';

export type ProtocolStreamError = HttpStreamError | ProtocolDecodeError;

export interface ProtocolError<Body = unknown> {
  kind: 'error';
  source: 'upstream' | 'local';
  error: Body;
}

export type ProtocolOutcome<Event, Output, Body = unknown> =
  | ([Event] extends [never] ? never : { kind: 'stream'; stream: ManagedStream<Event, ProtocolStreamError> })
  | ([Output] extends [never] ? never : { kind: 'result'; result: Output })
  | ProtocolError<Body>;

export interface ProviderUpstream<Kind extends UpstreamProviderKind = UpstreamProviderKind, Config = unknown> {
  readonly id: string;
  readonly kind: Kind;
  readonly name: string;
  readonly config: Config;
}

export type ProviderModelFact = Omit<ProviderModel, 'enabledFlags'> & { readonly enabledFlags: readonly FlagId[] };

export const toProviderModelFact = ({ enabledFlags, ...model }: ProviderModel): ProviderModelFact => ({
  ...model,
  enabledFlags: [...enabledFlags],
});

export interface ProviderServices {
  fetcher(upstreamId: string): ProviderFetcher;
}

export interface MultipartFile {
  name: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface OpenAIAudioTranscriptionPayload {
  entries: readonly { name: string; value: string | MultipartFile }[];
}

type OpenAIImagesEditsInput = Exclude<OpenAIImagesEditsSource, { type: 'upload' }> | { type: 'upload'; file: MultipartFile };

export interface OpenAIImagesEditsPayload {
  images: OpenAIImagesEditsInput[];
  mask?: OpenAIImagesEditsInput;
  parameters: JsonObject;
}

type AnthropicMessagesCountTokensPayload = Omit<AnthropicMessagesPayload, 'max_tokens' | 'stream'>;

type Operation<Request, Event, Output> = {
  request: Request;
  event: Event;
  result: Output;
};

interface Operations {
  alphaSearch: Operation<JsonObject, never, Uint8Array | JsonObject>;
  anthropicMessages: Operation<AnthropicMessagesPayload, AnthropicMessagesStreamEventEx, never>;
  anthropicMessagesCountTokens: Operation<AnthropicMessagesCountTokensPayload, never, AnthropicMessagesCountTokensResult | null>;
  decision: Operation<CanonicalDecisionRequest, never, Uint8Array | CanonicalDecisionResponse>;
  geminiGenerateContent: Operation<GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent, never>;
  geminiGenerateContentCountTokens: Operation<GeminiCountTokensPayload, never, GeminiGenerateContentCountTokensResult | null>;
  openaiAudioSpeech: Operation<OpenAIAudioSpeechPayload, OpenAIAudioSpeechStreamEvent, Uint8Array>;
  openaiAudioTranscriptions: Operation<OpenAIAudioTranscriptionPayload, OpenAIAudioTranscriptionStreamItem, Uint8Array>;
  openaiChatCompletions: Operation<OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent, never>;
  openaiCompletions: Operation<OpenAICompletionsPayload, OpenAICompletionsStreamEvent, OpenAICompletionsResult>;
  openaiEmbeddings: Operation<OpenAIEmbeddingsPayload, never, JsonObject>;
  openaiImagesEdits: Operation<OpenAIImagesEditsPayload, OpenAIImagesStreamEvent, JsonObject>;
  openaiImagesGenerations: Operation<OpenAIImagesGenerationsPayload, OpenAIImagesStreamEvent, JsonObject>;
  openaiResponses: Operation<CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx, never>;
  openaiResponsesCompact: Operation<CanonicalOpenAIResponsesCompactPayload, never, OpenAIResponsesCompactionResultEx>;
  rerank: Operation<CanonicalRerankRequest, never, Uint8Array | CanonicalRerankResponse>;
}

interface CollectedChatResults {
  anthropicMessages: AnthropicMessagesResult;
  geminiGenerateContent: GeminiGenerateContentResult;
  openaiChatCompletions: OpenAIChatCompletionsResultEx;
  openaiResponses: OpenAIResponsesResultEx;
}

type CollectedOutcome<Op> = Op extends keyof CollectedChatResults ? { kind: 'result'; result: CollectedChatResults[Op] } : never;

export type ProviderOperation = keyof Operations;
export type ProviderEvent<Op extends ProviderOperation> = Operations[Op]['event'];
export type ProviderResult<Op extends ProviderOperation> = Operations[Op]['result'];
export type ProviderOutcome<Op extends ProviderOperation> = ProtocolOutcome<ProviderEvent<Op>, ProviderResult<Op>>;

export type GatewayFacts = {
  'request.http': HttpRequestFact;
  'response.http': HttpResponseFact | null;
  'response.usageModelKey'?: string;
  'provider.upstream': ProviderUpstream;
  'provider.model': ProviderModelFact;
} & {
  [Op in ProviderOperation as `request.${Op}`]: Operations[Op]['request'];
} & {
  [Op in ProviderOperation as `response.${Op}`]: ProviderOutcome<Op> | CollectedOutcome<Op>;
};

export interface HttpTerminalFacts {
  'response.http.error': HttpStreamError;
}

export type ProviderRequestFacts<Op extends ProviderOperation, Upstream extends ProviderUpstream = ProviderUpstream> =
  Pick<GatewayFacts, 'request.http' | 'provider.model' | `request.${Op}`> & { 'provider.upstream': Upstream };

export type ProviderResponseFacts<Op extends ProviderOperation> = Pick<GatewayFacts, 'response.http' | 'response.usageModelKey'> & {
  [Name in Op as `response.${Name}`]: ProviderOutcome<Name>;
};

export type ProviderOperationFacts<Op extends ProviderOperation, Upstream extends ProviderUpstream = ProviderUpstream> =
  Omit<GatewayFacts, 'provider.upstream' | `response.${Op}`> & ProviderRequestFacts<Op, Upstream> & ProviderResponseFacts<Op> & HttpTerminalFacts;

export type ProviderPipelines<Services = ProviderServices, Upstream extends ProviderUpstream = ProviderUpstream> = {
  readonly [Op in ProviderOperation]?: Pipeline<ProviderRequestFacts<Op, Upstream>, ProviderResponseFacts<Op>, Services>;
};
