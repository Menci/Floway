import type { HttpRequestFacts, HttpResponseFacts } from '@floway-dev/http/pipeline';
import type { Deferred, Secret } from '@floway-dev/pipeline';
import type { ProviderOperationPayloads, ProviderRequest } from '@floway-dev/provider';

export type EmbeddingsRequest = ProviderRequest<ProviderOperationPayloads['openaiEmbeddings']>;
export interface CopilotSession {
  readonly token: Secret<string>;
  readonly expiresAt: number;
  readonly baseUrl: string;
}
export interface CopilotRequest extends EmbeddingsRequest {
  'request.copilot.session': CopilotSession;
}
export interface CopilotHttpFacts extends HttpRequestFacts {
  'request.copilot.modelKey': string;
  'request.provider.modelKey': string;
}
export type QuotaResponse = HttpResponseFacts & { 'response.copilot.quota': Deferred<unknown> };
