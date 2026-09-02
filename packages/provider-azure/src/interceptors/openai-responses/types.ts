import type { Interceptor } from '@floway-dev/interceptor';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import type { ProviderModel, ProviderOpenAIResponsesResult, OpenAIResponsesAction } from '@floway-dev/provider';

export interface OpenAIResponsesBoundaryCtx {
  payload: CanonicalOpenAIResponsesPayload;
  headers: Headers;
  readonly model: ProviderModel;
  action: OpenAIResponsesAction;
}

export type AzureOpenAIResponsesBoundaryInterceptor = Interceptor<
  OpenAIResponsesBoundaryCtx,
  object,
  ProviderOpenAIResponsesResult
>;
