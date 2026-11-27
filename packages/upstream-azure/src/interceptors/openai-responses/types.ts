import type { Interceptor } from '@floway-dev/interceptor';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import type { UpstreamModel, UpstreamOpenAIResponsesResult, OpenAIResponsesAction } from '@floway-dev/upstream';

export interface OpenAIResponsesBoundaryCtx {
  payload: CanonicalOpenAIResponsesPayload;
  headers: Headers;
  readonly model: UpstreamModel;
  action: OpenAIResponsesAction;
}

export type AzureOpenAIResponsesBoundaryInterceptor = Interceptor<
  OpenAIResponsesBoundaryCtx,
  object,
  UpstreamOpenAIResponsesResult
>;
