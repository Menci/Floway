import { defineCopilotStage } from '../facts.ts';
import { detachCopilotQuota } from './observe-quota.ts';
import { setHeader, type HttpBodyError } from '@floway-dev/http';
import { httpDialError, type FormatProtocolError, type ProviderOperation } from '@floway-dev/provider';

export const authorize = (operation: ProviderOperation, format: FormatProtocolError) => {
  const response = `response.${operation}` as const;
  return defineCopilotStage({
    name: `copilot.${operation}.authorize`,
    through: {
      request: { needs: ['request.http', 'provider.upstream'], provides: ['request.http'], consumes: [] },
      response: { needs: ['response.http'], provides: [], consumes: [] },
    },
    return: { provides: ['response.http', `${response}?`] },
    async execute(facts, scope) {
      const upstream = facts['provider.upstream'];
      const credentials = await scope.services.copilot.credentials(
        upstream,
        scope.services.fetcher(upstream.id),
        scope.signal,
        (message, error) => { scope.log.withError(error).warn(message); },
        headers => { detachCopilotQuota(scope, upstream.id, headers); },
      );
      if (!credentials.ok) {
        const failure = credentials.error;
        if (failure.kind === 'http') {
          const { body } = failure;
          return { 'response.http': { ...failure.head, body: body === null ? null : scope.createStream(() => body) } };
        }
        if (failure.head !== null) {
          const body = scope.createStream<Uint8Array, HttpBodyError>(async function* () { yield { ok: false, error: failure.error }; });
          return { 'response.http': { ...failure.head, body } };
        }
        return { 'response.http': null, [response]: httpDialError(failure.error, format) };
      }

      const { baseUrl, token } = credentials.value;
      const http = facts['request.http'];
      const headers = setHeader(http.headers, 'authorization', token.map(value => `Bearer ${value}`));
      return await scope.next({ ...facts, 'request.http': { ...http, url: baseUrl, headers } });
    },
  });
};
