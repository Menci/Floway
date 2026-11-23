import type { OpenAIAudioTranscriptionRequest } from './audio.ts';
import type { FlagId } from './flags.ts';
import type { OpenAIImagesEditsRequest } from './images.ts';
import type { ProviderModel, UpstreamProviderKind } from './model.ts';
import type { Fetcher, HttpRequestFacts, HttpResponseFacts, TransportFailure } from '@floway-dev/http';
import type { FactValue, ManagedStream, Pipeline } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { DecisionTarget, ProtocolFrame, RerankTarget } from '@floway-dev/protocols/common';
import type { CanonicalDecisionRequest } from '@floway-dev/protocols/decision';
import type { GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAICompletionsPayload } from '@floway-dev/protocols/openai-completions';
import type { OpenAIEmbeddingsPayload } from '@floway-dev/protocols/openai-embeddings';
import type { OpenAIImagesGenerationsPayload } from '@floway-dev/protocols/openai-images';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesCompactionResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { CanonicalRerankRequest } from '@floway-dev/protocols/rerank';

export interface ProviderServices {
  readonly fetcher: (upstreamId: string) => Fetcher;
}

export type ProviderModelFacts = Readonly<Omit<ProviderModel, 'enabledFlags'>> & {
  readonly enabledFlags: readonly FlagId[];
};

export const toProviderModelFacts = (model: ProviderModel): ProviderModelFacts => ({
  ...model,
  enabledFlags: Object.freeze([...model.enabledFlags]),
});

export type OpenAIResponsesAction = 'generate' | 'compact';

export interface ProviderUpstreamBase<Kind extends UpstreamProviderKind = UpstreamProviderKind, Config = unknown> {
  readonly kind: Kind;
  readonly id: string;
  readonly name: string;
  readonly config: Config;
}

export interface ProviderInput<Upstream extends ProviderUpstreamBase, Payload> {
  readonly 'provider.upstream': Upstream;
  readonly 'provider.model': ProviderModelFacts;
  readonly 'request.http': HttpRequestFacts;
  readonly 'request.payload': Payload;
}

export interface ProviderAnthropicInput<Upstream extends ProviderUpstreamBase = ProviderUpstreamBase>
  extends ProviderInput<Upstream, Omit<AnthropicMessagesPayload, 'model'>> {
  readonly 'request.anthropicBeta': readonly string[];
}

export interface ProviderResponsesInput<Upstream extends ProviderUpstreamBase = ProviderUpstreamBase>
  extends ProviderInput<Upstream, Omit<CanonicalOpenAIResponsesPayload, 'model'>> {
  readonly 'request.action': OpenAIResponsesAction;
}

export type ErrorSource = 'upstream' | 'local';

export type ProviderFrame<Event> = ProtocolFrame<Event> | TransportFailure;

export type ProtocolOutcome<Event, Result = never, ErrorBody = FactValue> =
  | { readonly kind: 'stream'; readonly events: ManagedStream<ProviderFrame<Event>> }
  | { readonly kind: 'result'; readonly result: Result }
  | { readonly kind: 'error'; readonly source: ErrorSource; readonly error: ErrorBody };

export type HttpOutcome<Extra extends object = {}> =
  | ({ readonly kind: 'ok' } & Extra)
  | { readonly kind: 'error'; readonly source: ErrorSource; readonly error: FactValue };

export interface ProviderBaseOutput {
  readonly 'response.http': HttpResponseFacts;
  readonly 'response.modelKey': string;
}

export type ProviderOpenAIChatCompletionsOutput = ProviderBaseOutput & { readonly 'response.openaiChatCompletions': ProtocolOutcome<OpenAIChatCompletionsStreamEvent> };
export type ProviderOpenAIResponsesOutput = ProviderBaseOutput & { readonly 'response.openaiResponses': ProtocolOutcome<OpenAIResponsesStreamEventEx, OpenAIResponsesCompactionResultEx> };
export type ProviderAnthropicMessagesOutput = ProviderBaseOutput & { readonly 'response.anthropicMessages': ProtocolOutcome<AnthropicMessagesStreamEventEx> };
export type ProviderGeminiGenerateContentOutput = ProviderBaseOutput & { readonly 'response.geminiGenerateContent': ProtocolOutcome<GeminiGenerateContentStreamEvent> };
export type ProviderAnthropicCountTokensOutput = ProviderBaseOutput & { readonly 'response.anthropicMessagesCountTokens': HttpOutcome };
export type ProviderGeminiCountTokensOutput = ProviderBaseOutput & { readonly 'response.geminiGenerateContentCountTokens': HttpOutcome };
export type ProviderOpenAICompletionsOutput = ProviderBaseOutput & { readonly 'response.openaiCompletions': HttpOutcome };
export type ProviderOpenAIEmbeddingsOutput = ProviderBaseOutput & { readonly 'response.openaiEmbeddings': HttpOutcome };
export type ProviderOpenAIImagesGenerationsOutput = ProviderBaseOutput & { readonly 'response.openaiImagesGenerations': HttpOutcome };
export type ProviderOpenAIImagesEditsOutput = ProviderBaseOutput & { readonly 'response.openaiImagesEdits': HttpOutcome };
export type ProviderOpenAIAudioTranscriptionsOutput = ProviderBaseOutput & { readonly 'response.openaiAudioTranscriptions': HttpOutcome };
export type ProviderRerankOutput = ProviderBaseOutput & { readonly 'response.rerank': HttpOutcome<{ readonly target: RerankTarget }> };
export type ProviderDecisionOutput = ProviderBaseOutput & { readonly 'response.decision': HttpOutcome<{ readonly target: DecisionTarget }> };
export type ProviderAlphaSearchOutput = ProviderBaseOutput & { readonly 'response.alphaSearch': HttpOutcome };

export interface ProviderPipelines<Upstream extends ProviderUpstreamBase = ProviderUpstreamBase, S extends ProviderServices = ProviderServices> {
  readonly alphaSearch?: Pipeline<ProviderInput<Upstream, Record<string, unknown>>, ProviderAlphaSearchOutput, S>;
  readonly openaiCompletions?: Pipeline<ProviderInput<Upstream, Omit<OpenAICompletionsPayload, 'model'>>, ProviderOpenAICompletionsOutput, S>;
  readonly openaiChatCompletions?: Pipeline<ProviderInput<Upstream, Omit<OpenAIChatCompletionsPayloadEx, 'model'>>, ProviderOpenAIChatCompletionsOutput, S>;
  readonly openaiResponses?: Pipeline<ProviderResponsesInput<Upstream>, ProviderOpenAIResponsesOutput, S>;
  readonly anthropicMessages?: Pipeline<ProviderAnthropicInput<Upstream>, ProviderAnthropicMessagesOutput, S>;
  readonly anthropicMessagesCountTokens?: Pipeline<ProviderAnthropicInput<Upstream>, ProviderAnthropicCountTokensOutput, S>;
  readonly geminiGenerateContent?: Pipeline<ProviderInput<Upstream, GeminiGenerateContentPayload>, ProviderGeminiGenerateContentOutput, S>;
  readonly geminiGenerateContentCountTokens?: Pipeline<ProviderInput<Upstream, GeminiGenerateContentPayload>, ProviderGeminiCountTokensOutput, S>;
  readonly openaiEmbeddings?: Pipeline<ProviderInput<Upstream, Omit<OpenAIEmbeddingsPayload, 'model'>>, ProviderOpenAIEmbeddingsOutput, S>;
  readonly openaiImagesGenerations?: Pipeline<ProviderInput<Upstream, Omit<OpenAIImagesGenerationsPayload, 'model'>>, ProviderOpenAIImagesGenerationsOutput, S>;
  readonly openaiImagesEdits?: Pipeline<ProviderInput<Upstream, OpenAIImagesEditsRequest>, ProviderOpenAIImagesEditsOutput, S>;
  readonly openaiAudioTranscriptions?: Pipeline<ProviderInput<Upstream, OpenAIAudioTranscriptionRequest>, ProviderOpenAIAudioTranscriptionsOutput, S>;
  readonly rerank?: Pipeline<ProviderInput<Upstream, CanonicalRerankRequest>, ProviderRerankOutput, S>;
  readonly decision?: Pipeline<ProviderInput<Upstream, CanonicalDecisionRequest>, ProviderDecisionOutput, S>;
}
