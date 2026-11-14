import type { HttpRequestFacts, HttpResponseFacts } from '@floway-dev/http/pipeline';
import type { Deferred, Secret } from '@floway-dev/pipeline';
import type { ProviderOperationPayloads, ProviderRequest } from '@floway-dev/provider';

/** The operations Copilot serves through pipelines. Each name is also the catalog endpoint key
 *  its raw model variant is selected by. */
export type CopilotOperation = 'openaiEmbeddings' | 'openaiImagesGenerations' | 'openaiImagesEdits' | 'decision';

export type CopilotOperationRequest<O extends CopilotOperation> = ProviderRequest<ProviderOperationPayloads[O]>;
export interface CopilotSession {
  readonly token: Secret<string>;
  readonly expiresAt: number;
  readonly baseUrl: string;
}
export type CopilotRequest<O extends CopilotOperation> = CopilotOperationRequest<O> & {
  'request.copilot.session': CopilotSession;
};
export interface CopilotHttpFacts extends HttpRequestFacts {
  'request.copilot.modelKey': string;
}
export type QuotaResponse = HttpResponseFacts & { 'response.copilot.quota': Deferred<unknown> };
