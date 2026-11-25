import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { responseHead } from '../../../pipeline/response.ts';
import { gatewayErrorStatus, geminiGenerateContentRpcErrorPayload, googleRpcHttpStatusCode, isGeminiGenerateContentErrorResponse } from '../errors.ts';
import { move, transform } from '@floway-dev/pipeline';

const { defineStage } = gatewayFactSpace<{}>();
const key = 'response.geminiGenerateContent';

export const normalizeGeminiGenerateContentErrorStatus = defineStage({
  name: 'geminiGenerateContent.normalize-error-status',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['response.http', key], provides: ['response.http', key], consumes: [] },
  },
  execute: transform(() => ({
    response: facts => {
      const http = facts['response.http'];
      const outcome = facts[key];
      if (http === null || http.status < 400 || outcome.kind !== 'error' || outcome.source !== 'upstream'
        || !isGeminiGenerateContentErrorResponse(outcome.error)) return facts;
      if (outcome.cause instanceof SyntaxError) {
        const status = gatewayErrorStatus(http.status) === 'INTERNAL' ? 500 : http.status;
        const error = geminiGenerateContentRpcErrorPayload(status, outcome.error.error.message || 'Upstream Gemini generateContent request failed.');
        return {
          ...facts,
          'response.http': status === http.status ? http : move({ ...http, status, statusText: responseHead(status).statusText }),
          [key]: move({ ...outcome, error }),
        };
      }

      const status = googleRpcHttpStatusCode(outcome.error.error.code);
      return status === http.status ? facts : { ...facts, 'response.http': move({ ...http, status, statusText: responseHead(status).statusText }) };
    },
  })),
});
