import { encode, encodedResponse, jsonResponse, localResponseHead } from '../pipeline/encode.ts';

export const encodeAlphaSearch = encode('alphaSearch', ({ http, outcome }) => {
  if (outcome.kind === 'error') {
    return jsonResponse(http ?? localResponseHead(outcome.source === 'upstream' ? 502 : 499), outcome.error);
  }
  if (http === null) throw new Error('Alpha Search result requires an HTTP response');
  return outcome.result instanceof Uint8Array
    ? encodedResponse(http, outcome.result)
    : jsonResponse(http, outcome.result);
});
