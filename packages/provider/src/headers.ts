import { filterHeaders, type HttpRequestFact } from '@floway-dev/http';
import { factSpace, move } from '@floway-dev/pipeline';

const { defineStage } = factSpace<{ readonly 'request.http': HttpRequestFact }>();

export const stripHeaders = (name: string, keep: (lowercaseName: string) => boolean) => defineStage({
  name,
  through: {
    request: { needs: ['request.http'], provides: ['request.http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const request = facts['request.http'];
    const headers = filterHeaders(request.headers, keep);
    if (headers.length === request.headers.length) return await scope.next(facts);
    return await scope.next({ ...facts, 'request.http': move({ ...request, headers }) });
  },
});
