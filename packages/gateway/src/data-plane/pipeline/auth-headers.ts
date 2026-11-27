import { filterHeaders, type HttpRequestFact } from '@floway-dev/http';
import { factSpace } from '@floway-dev/pipeline';

const authenticationHeaders = new Set([
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'x-floway-session',
]);

const { defineStage } = factSpace<{ http: HttpRequestFact }, object>();

export const stripAuthenticationHeaders = defineStage({
  name: 'strip-authentication-headers',
  through: {
    request: { needs: ['http'], provides: ['http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const { http } = facts;
    const headers = filterHeaders(http.headers, name => !authenticationHeaders.has(name));
    return await scope.next(headers.length === http.headers.length ? facts : { ...facts, http: { ...http, headers } });
  },
});
