import type { OpenAIAudioTranscriptionRequest } from './audio.ts';
import type { FlagId } from './flags.ts';
import type { OpenAIImagesEditsRequest } from './images.ts';
import type { ProviderModel } from './model.ts';
import type { HttpResponseFacts, HttpHeaders, HttpServices } from '@floway-dev/http/pipeline';
import type { Pipeline } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame, RerankTarget } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAICompletionsPayload } from '@floway-dev/protocols/openai-completions';
import type { OpenAIEmbeddingsPayload } from '@floway-dev/protocols/openai-embeddings';
import type { OpenAIImagesGenerationsPayload } from '@floway-dev/protocols/openai-images';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesCompactionResult, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import type { CanonicalRerankRequest } from '@floway-dev/protocols/rerank';

export interface ProviderOperationPayloads {
  openaiChatCompletions: Omit<OpenAIChatCompletionsPayload, 'model'>;
  openaiResponses: Omit<CanonicalOpenAIResponsesPayload, 'model'>;
  openaiResponsesCompact: Omit<CanonicalOpenAIResponsesPayload, 'model'>;
  anthropicMessages: Omit<AnthropicMessagesPayload, 'model'>;
  anthropicMessagesCountTokens: Omit<AnthropicMessagesPayload, 'model'>;
  alphaSearch: Record<string, unknown>;
  openaiCompletions: Omit<OpenAICompletionsPayload, 'model'>;
  openaiEmbeddings: Omit<OpenAIEmbeddingsPayload, 'model'>;
  openaiImagesGenerations: Omit<OpenAIImagesGenerationsPayload, 'model'>;
  openaiImagesEdits: OpenAIImagesEditsRequest;
  openaiAudioTranscriptions: OpenAIAudioTranscriptionRequest;
  rerank: CanonicalRerankRequest;
}

export type ProviderOperation = keyof ProviderOperationPayloads;
export type ChatProviderOperation = 'openaiChatCompletions' | 'openaiResponses' | 'openaiResponsesCompact' | 'anthropicMessages' | 'anthropicMessagesCountTokens';
export type NonChatProviderOperation = Exclude<ProviderOperation, ChatProviderOperation>;

export type ProviderModelFacts = Omit<ProviderModel, 'enabledFlags'> & { readonly enabledFlags: readonly FlagId[] };

export const providerModelFacts = (model: ProviderModel): ProviderModelFacts => ({ ...model, enabledFlags: [...model.enabledFlags] });

export interface ProviderRequest<P> {
  'request.provider.model': ProviderModelFacts;
  'request.provider.payload': P;
  'request.http.callId': number;
  'request.http.headers': HttpHeaders;
}

export type ProviderOperationRequest<O extends ProviderOperation> = ProviderRequest<ProviderOperationPayloads[O]> &
  (O extends 'anthropicMessages' | 'anthropicMessagesCountTokens' ? { 'request.provider.anthropicBeta': readonly string[] } : object);

export interface ProviderCallResponse extends HttpResponseFacts {
  /** A preflight reply does not represent a call to the model endpoint. */
  'response.provider.called': boolean;
  /** Credential retries retain replaced endpoint replies so settlement counts each call. */
  'response.provider.previousCalls': readonly { readonly modelKey: string }[];
}

export interface ProviderResponse extends ProviderCallResponse {
  'response.provider.modelKey': string;
}

export interface ProviderRerankResponse extends ProviderResponse {
  'response.provider.rerankTarget': RerankTarget;
}

export interface ProviderProtocolFailure {
  readonly status: number;
  readonly message: string;
  readonly body?: unknown;
}

export type ProviderStreamOutput<E> = { readonly kind: 'stream'; readonly frames: AsyncIterable<ProtocolFrame<E>> };
export type ProviderValueOutput<T> = { readonly kind: 'value'; readonly body: T };
export interface AnthropicMessagesCountTokensBody {
  readonly input_tokens: number;
  readonly [key: string]: unknown;
}

export interface ProviderOperationOutputs {
  openaiChatCompletions: ProviderStreamOutput<OpenAIChatCompletionsStreamEvent>;
  openaiResponses: ProviderStreamOutput<OpenAIResponsesStreamEvent> | ProviderValueOutput<OpenAIResponsesCompactionResult>;
  openaiResponsesCompact: ProviderStreamOutput<OpenAIResponsesStreamEvent> | ProviderValueOutput<OpenAIResponsesCompactionResult>;
  anthropicMessages: ProviderStreamOutput<AnthropicMessagesStreamEvent>;
  anthropicMessagesCountTokens: ProviderValueOutput<AnthropicMessagesCountTokensBody>;
}

export interface ProviderChatResponse<O extends ChatProviderOperation> extends ProviderResponse {
  'response.provider.output': ProviderOperationOutputs[O] | ProviderProtocolFailure | null;
}

export type ProviderOperationResponse<O extends ProviderOperation> =
  O extends ChatProviderOperation ? ProviderChatResponse<O> : O extends 'rerank' ? ProviderRerankResponse : ProviderResponse;

export type ProviderPipeline<O extends ProviderOperation> = Pipeline<
  ProviderOperationRequest<O>,
  ProviderOperationResponse<O>
>;

export type ProviderPipelines = { readonly [O in ProviderOperation]?: ProviderPipeline<O> };
export type ProviderServices = HttpServices;

export type ProviderChatServices = ProviderServices & {
  readonly recordProtocolFrames: <T extends ProtocolFrame<unknown>>(frames: AsyncIterable<T>) => AsyncIterable<T>;
};
