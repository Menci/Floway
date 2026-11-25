import type { OpenAIAudioTranscriptionRequest } from './audio.ts';
import type { FlagId } from './flags.ts';
import type { OpenAIImagesEditsRequest } from './images.ts';
import type { ProviderModel, UpstreamProviderKind } from './model.ts';
import type { FetchInit, HttpRequestFact, HttpResponseFact, HttpStreamError } from '@floway-dev/http';
import type { ManagedStream, Pipeline, Result } from '@floway-dev/pipeline';
import type { AnthropicMessagesCountTokensPayload, AnthropicMessagesCountTokensResult, AnthropicMessagesPayload, AnthropicMessagesResult, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { JsonObject } from '@floway-dev/protocols/common';
import type { CanonicalDecisionRequest, CanonicalDecisionResponse } from '@floway-dev/protocols/decision';
import type { GeminiGenerateContentCountTokensPayload, GeminiGenerateContentCountTokensResult, GeminiGenerateContentPayload, GeminiGenerateContentResult, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIAudioTranscriptionStreamEvent } from '@floway-dev/protocols/openai-audio';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsResultEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAICompletionsPayload, OpenAICompletionsResult, OpenAICompletionsStreamEvent } from '@floway-dev/protocols/openai-completions';
import type { OpenAIEmbeddingsPayload } from '@floway-dev/protocols/openai-embeddings';
import type { OpenAIImagesGenerationsPayload, OpenAIImagesStreamEvent } from '@floway-dev/protocols/openai-images';
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

type Operation<Name extends string, Request, Event, Output> = {
  readonly protocol: Name;
  readonly request: Request;
  readonly outcome: ProtocolOutcome<Event, Output>;
};

interface Operations {
  readonly alphaSearch: Operation<'alphaSearch', JsonObject, never, JsonObject>;
  readonly anthropicMessages: Operation<'anthropicMessages', AnthropicMessagesPayload, AnthropicMessagesStreamEventEx, never>;
  readonly anthropicMessagesCountTokens: Operation<'anthropicMessages', AnthropicMessagesCountTokensPayload, never, AnthropicMessagesCountTokensResult | null>;
  readonly decision: Operation<'decision', CanonicalDecisionRequest, never, CanonicalDecisionResponse>;
  readonly geminiGenerateContent: Operation<'geminiGenerateContent', GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent, never>;
  readonly geminiGenerateContentCountTokens: Operation<'geminiGenerateContent', GeminiGenerateContentCountTokensPayload, never, GeminiGenerateContentCountTokensResult | null>;
  readonly openaiAudioTranscriptions: Operation<'openaiAudioTranscriptions', OpenAIAudioTranscriptionRequest, OpenAIAudioTranscriptionStreamEvent, Uint8Array>;
  readonly openaiChatCompletions: Operation<'openaiChatCompletions', OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent, never>;
  readonly openaiCompletions: Operation<'openaiCompletions', OpenAICompletionsPayload, OpenAICompletionsStreamEvent, OpenAICompletionsResult>;
  readonly openaiEmbeddings: Operation<'openaiEmbeddings', OpenAIEmbeddingsPayload, never, JsonObject>;
  readonly openaiImagesEdits: Operation<'openaiImagesEdits', OpenAIImagesEditsRequest, OpenAIImagesStreamEvent, JsonObject>;
  readonly openaiImagesGenerations: Operation<'openaiImagesGenerations', OpenAIImagesGenerationsPayload, OpenAIImagesStreamEvent, JsonObject>;
  readonly openaiResponses: Operation<'openaiResponses', CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx, never>;
  readonly openaiResponsesCompact: Operation<'openaiResponses', CanonicalOpenAIResponsesCompactPayload, never, OpenAIResponsesCompactionResultEx>;
  readonly rerank: Operation<'rerank', CanonicalRerankRequest, never, CanonicalRerankResponse>;
}

interface CollectedChatResults {
  readonly anthropicMessages: AnthropicMessagesResult;
  readonly geminiGenerateContent: GeminiGenerateContentResult;
  readonly openaiChatCompletions: OpenAIChatCompletionsResultEx;
  readonly openaiResponses: OpenAIResponsesResultEx;
}

export type ProviderOperation = keyof Operations;
type ProviderProtocol = Operations[ProviderOperation]['protocol'];
type OperationsFor<Name extends ProviderProtocol> = Extract<Operations[ProviderOperation], { readonly protocol: Name }>;
type CollectedOutcome<Name extends ProviderProtocol> = Name extends keyof CollectedChatResults
  ? { readonly kind: 'result'; readonly result: CollectedChatResults[Name] }
  : never;

export type GatewayFacts = {
  readonly 'request.http': HttpRequestFact;
  readonly 'response.http': HttpResponseFact | null;
  readonly 'response.modelKey': string;
  readonly 'provider.upstream': ProviderUpstream;
  readonly 'provider.model': ProviderModelFact;
} & {
  readonly [Name in ProviderProtocol as `request.${Name}`]: OperationsFor<Name>['request'];
} & {
  readonly [Name in ProviderProtocol as `response.${Name}`]: OperationsFor<Name>['outcome'] | CollectedOutcome<Name>;
};

type ProviderRequestFacts<Op extends ProviderOperation, Upstream extends ProviderUpstream> =
  Pick<GatewayFacts, 'request.http' | 'provider.model'> &
  { readonly 'provider.upstream': Upstream } &
  Readonly<Record<`request.${Operations[Op]['protocol']}`, Operations[Op]['request']>>;
type ProviderResponseFacts<Op extends ProviderOperation> = Pick<GatewayFacts, 'response.http' | 'response.modelKey'> &
  Readonly<Record<`response.${Operations[Op]['protocol']}`, Operations[Op]['outcome']>>;

// A provider package narrows `provider.upstream` to its own projected config so stages read it without casts.
export type ProviderOperationFacts<Op extends ProviderOperation, Upstream extends ProviderUpstream = ProviderUpstream> =
  Omit<GatewayFacts, 'provider.upstream'> & ProviderRequestFacts<Op, Upstream> & ProviderResponseFacts<Op>;

export type ProviderPipelines<S = ProviderServices, Upstream extends ProviderUpstream = ProviderUpstream> = {
  readonly [Op in ProviderOperation]?: Pipeline<ProviderRequestFacts<Op, Upstream>, ProviderResponseFacts<Op>, S>;
};
