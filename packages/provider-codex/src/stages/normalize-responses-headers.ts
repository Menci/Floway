import { CODEX_RESPONSES_LITE_HEADER } from '../constants.ts';
import type { CodexResponsesHttpFacts } from './prepare-responses.ts';
import type { HttpResponseFacts } from '@floway-dev/http/pipeline';
import { defineStage, move } from '@floway-dev/pipeline';
import { isEventStreamMediaType } from '@floway-dev/protocols/common';

// The subscription endpoint can return valid SSE without the media-type header.
// Preserve the body lease and normalize the metadata before protocol decoding.
export const normalizeCodexResponsesHeaders = defineStage<CodexResponsesHttpFacts, CodexResponsesHttpFacts, HttpResponseFacts, HttpResponseFacts>({
  name: 'normalizeCodexResponsesHeaders',
  through: {
    request: { needs: ['request.provider.responsesAction'], consumes: [], provides: [] },
    response: { needs: ['response.http.exchange'], consumes: ['response.http.exchange'], provides: ['response.http.exchange'] },
  },
  execute: async (facts, next) => {
    const back = await next(move({ ...facts }));
    const exchange = back['response.http.exchange'];
    if (facts['request.provider.responsesAction'] === 'compact' || exchange.type !== 'response' || exchange.status < 200 || exchange.status >= 300) return move({ ...back });
    const contentType = exchange.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1];
    const headers = exchange.headers.filter(([name]) => name.toLowerCase() !== CODEX_RESPONSES_LITE_HEADER);
    if (!isEventStreamMediaType(contentType)) {
      const normalized = headers.filter(([name]) => name.toLowerCase() !== 'content-type');
      normalized.push(['content-type', 'text/event-stream']);
      return move({ ...back, 'response.http.exchange': { ...exchange, headers: normalized } });
    }
    return move({ ...back, 'response.http.exchange': { ...exchange, headers } });
  },
});
