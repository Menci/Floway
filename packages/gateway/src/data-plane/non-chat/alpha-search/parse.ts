import { defineStage } from '../../pipeline/facts.ts';
import { decodeRequestBody, jsonResponse, localHead } from '../shared/http.ts';
import { isJsonObject } from '@floway-dev/protocols/common';

export const parse = defineStage({
  name: 'alphaSearch.parse',
  through: {
    request: { needs: ['http', 'serve.startedAt'], provides: ['alphaSearch'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http'] },
  async execute(facts, scope) {
    const invalid = (message: string) => {
      scope.services.dump?.error('gateway');
      return { http: jsonResponse(localHead(400), { error: message }) };
    };
    let body: unknown;
    try {
      body = JSON.parse(decodeRequestBody(facts.http));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return invalid('Malformed JSON in request body');
    }
    if (!isJsonObject(body)) return invalid('Alpha Search request body must be an object.');
    if (typeof body.model === 'string') scope.services.dump?.requestedModel(body.model);
    return await scope.next({ ...facts, alphaSearch: body });
  },
});
