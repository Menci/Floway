import { isCopilotTokenFetchError } from '../../auth.ts';
import { defineCopilotStage, type CopilotFacts } from '../facts.ts';
import { responseHeaderEntries, setHeader } from '@floway-dev/http';
import { move } from '@floway-dev/pipeline';
import { parseErrorBody, type FormatProviderError, type ProtocolError } from '@floway-dev/provider';

type ProtocolResponseKey = Exclude<Extract<keyof CopilotFacts, `response.${string}`>, 'response.http' | 'response.modelKey' | 'response.transport'>;

const errorFact = <Key extends ProtocolResponseKey>(key: Key, outcome: ProtocolError): Record<Key, ProtocolError> =>
  ({ [key]: move(outcome) }) as Record<Key, ProtocolError>;

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
    const credentials = await scope.services.copilot.credentials(upstream, scope.services.fetcher(upstream.id), scope.signal);
    if (!credentials.ok) {
      const failure = credentials.error;
      if (isCopilotTokenFetchError(failure)) {
        const { response, body } = failure;
        const parsed = await parseErrorBody({
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaderEntries(response),
          body,
        }, format);
        return { 'response.http': move(parsed.http), 'response.modelKey': modelKey, ...errorFact(key, parsed.outcome) };
      }
      return {
        'response.http': null,
        'response.modelKey': modelKey,
        ...errorFact(key, {
          kind: 'error',
          source: 'upstream',
          error: format(null, failure.cause instanceof Error ? failure.cause.message : String(failure.cause)),
          cause: failure,
        }),
      };
    }

    return await scope.next({
      ...facts,
      'request.http': move({
        ...request,
        url: `${credentials.value.baseUrl}${request.url}`,
        headers: setHeader(request.headers, 'authorization', credentials.value.token.map(token => `Bearer ${token}`)),
      }),
    });
  },
});
