import type { OpenAIAudioTranscriptionRequest } from './audio.ts';
import type { FlagId } from './flags.ts';
import type { OpenAIImagesEditsRequest } from './images.ts';
import type { ProviderModel, UpstreamProviderKind } from './model.ts';
import type { FetchInit, HttpRequestFact, HttpResponseFact, HttpStreamError } from '@floway-dev/http';
import type { ManagedStream, Pipeline, Result } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload, AnthropicMessagesResult, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { JsonObject } from '@floway-dev/protocols/common';
import type { CanonicalDecisionRequest, CanonicalDecisionResponse } from '@floway-dev/protocols/decision';
import type { GeminiCountTokensPayload, GeminiGenerateContentPayload, GeminiGenerateContentResult, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIAudioTranscriptionStreamEvent } from '@floway-dev/protocols/openai-audio';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsResultEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAICompletionsPayload, OpenAICompletionsResult, OpenAICompletionsStreamEvent } from '@floway-dev/protocols/openai-completions';
import type { OpenAIEmbeddingsPayload } from '@floway-dev/protocols/openai-embeddings';
import type { OpenAIImagesGenerationsPayload } from '@floway-dev/protocols/openai-images';
import type { CanonicalOpenAIResponsesCompactPayload, CanonicalOpenAIResponsesPayload, OpenAIResponsesCompactionResultEx, OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { CanonicalRerankRequest, CanonicalRerankResponse } from '@floway-dev/protocols/rerank';

export type ProtocolStreamError = HttpStreamError | { readonly kind: 'protocol'; readonly cause: unknown };

export interface ProtocolError<Body = unknown> {
  readonly kind: 'error';
  readonly source: 'upstream' | 'local';
  readonly error: Body;
  readonly cause?: unknown;
}

export type ProtocolOutcome<Event, Output, ErrorBody = unknown> =
  | ([Event] extends [never] ? never : { readonly kind: 'stream'; readonly stream: ManagedStream<Event, ProtocolStreamError> })
  | ([Output] extends [never] ? never : { readonly kind: 'result'; readonly result: Output })
  | ProtocolError<ErrorBody>;

export interface ProviderUpstream<Kind extends UpstreamProviderKind = UpstreamProviderKind, Config = unknown> {
  readonly id: string;
  readonly kind: Kind;
  readonly name: string;
  readonly config: Readonly<Config>;
}

export type ProviderModelFact = Readonly<Omit<ProviderModel, 'enabledFlags'>> & { readonly enabledFlags: readonly FlagId[] };

export const toProviderModelFact = ({ enabledFlags, ...model }: ProviderModel): ProviderModelFact => ({
  ...model,
  enabledFlags: [...enabledFlags],
});

export interface ProviderServices {
  readonly fetcher: (upstreamId: string) => (url: string, init: FetchInit) => Promise<Result<Response, HttpStreamError>>;
}

type Protocol<Request, Event, Output> = {
  readonly request: Request;
  readonly outcome: ProtocolOutcome<Event, Output>;
};

interface Protocols {
  readonly alphaSearch: Protocol<JsonObject, never, JsonObject>;
  readonly anthropicMessages: Protocol<AnthropicMessagesPayload | Omit<AnthropicMessagesPayload, 'max_tokens'>, AnthropicMessagesStreamEventEx, AnthropicMessagesResult | JsonObject>;
  readonly decision: Protocol<CanonicalDecisionRequest, never, CanonicalDecisionResponse>;
  readonly geminiGenerateContent: Protocol<GeminiGenerateContentPayload | GeminiCountTokensPayload, GeminiGenerateContentStreamEvent, GeminiGenerateContentResult | JsonObject>;
  readonly openaiAudioTranscriptions: Protocol<OpenAIAudioTranscriptionRequest, OpenAIAudioTranscriptionStreamEvent, Uint8Array>;
  readonly openaiChatCompletions: Protocol<OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsResultEx>;
  readonly openaiCompletions: Protocol<OpenAICompletionsPayload, OpenAICompletionsStreamEvent, OpenAICompletionsResult>;
  readonly openaiEmbeddings: Protocol<OpenAIEmbeddingsPayload, never, JsonObject>;
  readonly openaiImagesEdits: Protocol<OpenAIImagesEditsRequest, never, JsonObject>;
  readonly openaiImagesGenerations: Protocol<OpenAIImagesGenerationsPayload, never, JsonObject>;
  readonly openaiResponses: Protocol<CanonicalOpenAIResponsesPayload | CanonicalOpenAIResponsesCompactPayload, OpenAIResponsesStreamEventEx, OpenAIResponsesResultEx | OpenAIResponsesCompactionResultEx>;
  readonly rerank: Protocol<CanonicalRerankRequest, never, CanonicalRerankResponse>;
}

type ProviderProtocol = keyof Protocols;

interface OperationProtocols {
  readonly anthropicMessagesCountTokens: 'anthropicMessages';
  readonly geminiGenerateContentCountTokens: 'geminiGenerateContent';
  readonly openaiResponsesCompact: 'openaiResponses';
}

export type ProviderOperation = ProviderProtocol | keyof OperationProtocols;

type ProtocolFor<Operation extends ProviderOperation> = Operation extends keyof OperationProtocols ? OperationProtocols[Operation] : Extract<Operation, ProviderProtocol>;

export type GatewayFacts = {
  readonly 'request.http': HttpRequestFact;
  readonly 'response.http': HttpResponseFact | null;
  readonly 'provider.upstream': ProviderUpstream;
  readonly 'provider.model': ProviderModelFact;
} & {
  readonly [Name in ProviderProtocol as `request.${Name}`]: Protocols[Name]['request'];
} & {
  readonly [Name in ProviderProtocol as `response.${Name}`]: Protocols[Name]['outcome'];
};

export type ProviderPipelines<S = ProviderServices> = {
  readonly [Operation in ProviderOperation]?: Pipeline<
    Pick<GatewayFacts, 'request.http' | 'provider.upstream' | 'provider.model' | `request.${ProtocolFor<Operation>}`>,
    Pick<GatewayFacts, 'response.http' | `response.${ProtocolFor<Operation>}`>,
    S
  >;
};
