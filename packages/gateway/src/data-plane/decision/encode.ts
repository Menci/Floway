import { encode, encodedResponse, jsonResponse, localResponseHead } from '../pipeline/encode.ts';
import { getHeader } from '@floway-dev/http';
import type { DecisionProtocol } from '@floway-dev/protocols/common';
import { renderDecisionResponse } from '@floway-dev/protocols/decision';

export const encodeDecision = (dialect: DecisionProtocol) => encode('decision', ({ http, outcome }) => {
  if (outcome.kind === 'error') {
    return jsonResponse(http ?? localResponseHead(outcome.source === 'upstream' ? 502 : 499), outcome.error);
  }
  if (http === null) throw new Error('Decision result requires an HTTP response');
  const { result } = outcome;
  if (result instanceof Uint8Array) return encodedResponse(http, result, getHeader(http.headers, 'content-type') === undefined ? 'application/json' : undefined);
  return jsonResponse(http, renderDecisionResponse(dialect, result));
});
