import type { CopilotCredentialFailure, CopilotCredentials } from '../../service.ts';
import { defineCopilotStage, type CopilotFacts } from '../facts.ts';
import { setHeader, type HttpRequestFact } from '@floway-dev/http';
import { move } from '@floway-dev/pipeline';
import { parseErrorBody, type FormatProviderError, type ProtocolError } from '@floway-dev/provider';

type ProtocolResponseKey = Exclude<Extract<keyof CopilotFacts, `response.${string}`>, 'response.http' | 'response.modelKey' | 'response.transport'>;

const errorFact = <Key extends ProtocolResponseKey>(key: Key, outcome: ProtocolError): Record<Key, ProtocolError> =>
  ({ [key]: move(outcome) }) as Record<Key, ProtocolError>;

export const authorizeRequest = (request: HttpRequestFact, credentials: CopilotCredentials): HttpRequestFact => move({
  ...request,
  url: `${credentials.baseUrl}${request.url}`,
  headers: setHeader(request.headers, 'authorization', credentials.token.map(token => `Bearer ${token}`)),
});

export const parseCredentialFailure = async (failure: CopilotCredentialFailure, format: FormatProviderError<unknown>) => {
  if (failure.kind === 'response') return await parseErrorBody({ ...failure.http, body: failure.body }, format);

  const { cause } = failure.error;
  return {
    http: null,
    outcome: {
      kind: 'error',
      source: 'upstream',
      error: format(null, cause instanceof Error ? cause.message : String(cause)),
      cause: failure.error,
    },
  } as const;
};

export const authorize = <const Key extends ProtocolResponseKey>(key: Key, format: FormatProviderError<unknown>) => defineCopilotStage({
  name: 'copilot.authorize',
  through: {
    request: { needs: ['request.http', 'provider.upstream', 'copilot.modelId'], provides: ['request.http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.modelKey', key] },
  async execute(facts, scope) {
    const upstream = facts['provider.upstream'];
    const request = facts['request.http'];
    const modelKey = facts['copilot.modelId'];
    const credentials = await scope.services.copilot.credentials(upstream, scope.services.fetcher(upstream.id));
    if (!credentials.ok) {
      const { http, outcome } = await parseCredentialFailure(credentials.error, format);
      return { 'response.http': move(http), 'response.modelKey': modelKey, ...errorFact(key, outcome) };
    }

    return await scope.next({
      ...facts,
      'request.http': authorizeRequest(request, credentials.value),
    });
  },
});
