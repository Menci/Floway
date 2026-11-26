import { encode, encodedResponse, jsonResponse, localResponseHead } from '../pipeline/encode.ts';
import { getHeader } from '@floway-dev/http';
import { renderCrossDialectRerankResponse } from '@floway-dev/protocols/rerank';

export const encodeRerank = encode('rerank', ({ http, outcome, request }) => {
  if (outcome.kind === 'error') {
    return jsonResponse(http ?? localResponseHead(outcome.source === 'upstream' ? 502 : 499), outcome.error);
  }
  if (http === null) throw new Error('Rerank result requires an HTTP response');
  const { result } = outcome;
  if (result instanceof Uint8Array) return encodedResponse(http, result, getHeader(http.headers, 'content-type') === undefined ? 'application/json' : undefined);
  return jsonResponse(http, renderCrossDialectRerankResponse(request, result));
}, 'request');
