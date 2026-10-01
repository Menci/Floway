import type { OpenAIAudioTranscriptionRequest } from './audio.ts';
import type { FlagId } from './flags.ts';
import type { OpenAIImagesEditsRequest } from './images.ts';
import type { ProviderModel } from './model.ts';
import type { HttpResponseFacts, HttpHeaders, HttpServices } from '@floway-dev/http/pipeline';
import type { Pipeline } from '@floway-dev/pipeline';
import type { RerankTarget } from '@floway-dev/protocols/common';
import type { OpenAICompletionsPayload } from '@floway-dev/protocols/openai-completions';
import type { OpenAIEmbeddingsPayload } from '@floway-dev/protocols/openai-embeddings';
import type { OpenAIImagesGenerationsPayload } from '@floway-dev/protocols/openai-images';
import type { CanonicalRerankRequest } from '@floway-dev/protocols/rerank';

export interface ProviderOperationPayloads {
  alphaSearch: Record<string, unknown>;
  openaiCompletions: Omit<OpenAICompletionsPayload, 'model'>;
  openaiEmbeddings: Omit<OpenAIEmbeddingsPayload, 'model'>;
  openaiImagesGenerations: Omit<OpenAIImagesGenerationsPayload, 'model'>;
  openaiImagesEdits: OpenAIImagesEditsRequest;
  openaiAudioTranscriptions: OpenAIAudioTranscriptionRequest;
  rerank: CanonicalRerankRequest;
}

export type ProviderOperation = keyof ProviderOperationPayloads;

export type ProviderModelFacts = Omit<ProviderModel, 'enabledFlags'> & { readonly enabledFlags: readonly FlagId[] };

export const providerModelFacts = (model: ProviderModel): ProviderModelFacts => ({ ...model, enabledFlags: [...model.enabledFlags] });

export interface ProviderRequest<P> {
  'request.provider.model': ProviderModelFacts;
  'request.provider.payload': P;
  'request.http.callId': number;
  'request.http.headers': HttpHeaders;
}

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

export type ProviderOperationResponse<O extends ProviderOperation> =
  O extends 'rerank' ? ProviderRerankResponse : ProviderResponse;

export type ProviderPipeline<O extends ProviderOperation> = Pipeline<
  ProviderRequest<ProviderOperationPayloads[O]>,
  ProviderOperationResponse<O>
>;

export type ProviderPipelines = { readonly [O in ProviderOperation]?: ProviderPipeline<O> };
export type ProviderServices = HttpServices;
