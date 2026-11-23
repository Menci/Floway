import type { HttpInput } from '../../../pipeline/edge-http.ts';
import { defineStage, transform } from '@floway-dev/pipeline';

// Beta flags are carried separately so translated routes never forward Anthropic's wire header.
const prepareHeaders = (name: string) => defineStage<HttpInput, HttpInput, object, object>({
  name,
  through: {
    request: { needs: ['request.http'], consumes: [], provides: ['request.http'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: transform(() => ({
    request: facts => {
      const http = facts['request.http'];
      const headers = http.headers.filter(([name]) => name.toLowerCase() !== 'anthropic-beta');
      return headers.length === http.headers.length ? facts : { ...facts, 'request.http': { ...http, headers } };
    },
  })),
});

export const prepareGenerate = prepareHeaders('prepareGenerate');
export const prepareCount = prepareHeaders('prepareCount');
