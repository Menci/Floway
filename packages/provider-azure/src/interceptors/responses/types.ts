import type { Interceptor } from '@floway-dev/interceptor';
import type { CanonicalResponsesPayload } from '@floway-dev/protocols/responses';
import type { ProviderModel, ProviderResponsesResult, ResponsesAction } from '@floway-dev/provider';

export interface ResponsesBoundaryCtx {
  payload: CanonicalResponsesPayload;
  headers: Headers;
  readonly model: ProviderModel;
  action: ResponsesAction;
}

export type AzureResponsesBoundaryInterceptor = Interceptor<
  ResponsesBoundaryCtx,
  object,
  ProviderResponsesResult
>;
