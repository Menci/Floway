import { jsonResponse, localResponseHead } from '../pipeline/encode.ts';
import { defineStage } from '../pipeline/facts.ts';
import type { RerankSourceProtocol } from '@floway-dev/protocols/common';
import { parseRerankRequest, RerankRequestValidationError } from '@floway-dev/protocols/rerank';

export const rerankError = (message: string) => ({ error: { message, type: 'api_error' } });

export const parseRerank = (dialect: RerankSourceProtocol) => defineStage({
  name: 'rerank.parse',
  through: {
    request: { needs: ['request.http'], provides: ['request.rerank'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.outcome'] },
  async execute(facts, scope) {
    const invalid = (message: string) => ({
      'response.http': jsonResponse(localResponseHead(400), rerankError(message)),
      'response.outcome': scope.createDeferred(async () => 'local' as const),
    });
    const { body } = facts['request.http'];
    let value: unknown;
    try {
      value = JSON.parse(body === null ? '' : new TextDecoder().decode(body));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return invalid('Rerank request body must be valid JSON');
    }

    let request: ReturnType<typeof parseRerankRequest>['request'];
    try {
      ({ request } = parseRerankRequest(dialect, value));
    } catch (error) {
      if (!(error instanceof RerankRequestValidationError)) throw error;
      return invalid(error.message);
    }
    return await scope.next({ ...facts, 'request.rerank': request });
  },
});
