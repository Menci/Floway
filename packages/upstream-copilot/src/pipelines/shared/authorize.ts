import { readCopilotAuth } from '../../config.ts';
import { hasCopilotQuotaHeaders } from '../../service.ts';
import { defineCopilotStage } from '../facts.ts';
import { setHeader, type HttpHeaders } from '@floway-dev/http';

export const authorize = defineCopilotStage({
  name: 'copilot.authorize',
  through: {
    request: { needs: ['http', 'upstream'], provides: ['http'], consumes: [] },
    response: { needs: ['http', 'http.error?'], provides: [], consumes: [] },
  },
  return: { provides: ['http', 'http.error?'] },
  async execute(facts, scope) {
    const { http, upstream } = facts;
    const credentials = await scope.services.copilot.credentials(
      readCopilotAuth(upstream),
      scope.services.fetcher(upstream.id),
      scope.signal,
      (message, cause) => { scope.log.withError(cause).warn(message); },
    );
    const { quotaTarget } = credentials;
    const observeQuota = (headers: HttpHeaders): void => {
      if (quotaTarget === null || !hasCopilotQuotaHeaders(headers)) return;
      scope.detach(async ({ services, log }) => {
        try {
          await services.copilot.observeQuota(quotaTarget, headers);
        } catch (error) {
          log.withField('upstreamId', quotaTarget.id).withError(error).warn('Failed to persist Copilot quota');
        }
      });
    };
    if (!credentials.ok) {
      const { error } = credentials;
      if (error.kind === 'io') return { http: null, 'http.error': error.error };
      const { body, ...response } = error.response;
      observeQuota(response.headers);
      return { http: { ...response, body: body === null ? null : scope.createStream(() => body) } };
    }

    const { baseUrl, token } = credentials.value;
    const headers = setHeader(http.headers, 'authorization', token.map(value => `Bearer ${value}`));
    const answer = await scope.next({ ...facts, http: { ...http, url: `${baseUrl}${http.url}`, headers } });
    if (answer.http !== null) observeQuota(answer.http.headers);
    return answer;
  },
});
