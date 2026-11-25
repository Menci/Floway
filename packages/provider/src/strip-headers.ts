import { filterHeaders, type HttpRequestFact } from '@floway-dev/http';
import { factSpace } from '@floway-dev/pipeline';

const { defineStage } = factSpace<{ 'request.http': HttpRequestFact }>();

export const stripHeaders = (name: string, keep: (lowercaseName: string) => boolean) => defineStage({
  name,
  through: {
    request: { needs: ['request.http'], provides: ['request.http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const request = facts['request.http'];
    const headers = filterHeaders(request.headers, keep);
    return await scope.next(headers.length === request.headers.length
      ? facts
      : { ...facts, 'request.http': { ...request, headers } });
  },
});
