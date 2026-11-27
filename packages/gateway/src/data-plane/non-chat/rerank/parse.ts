import { defineStage } from './facts.ts';
import { decodeRequestBody, jsonResponse, localHead, openAIError } from '../shared/http.ts';
import { parseRerankRequest } from '@floway-dev/protocols/rerank';

export const parse = defineStage({
  name: 'rerank.parse',
  through: {
    request: { needs: ['http', 'serve.startedAt', 'rerankDialect'], provides: ['rerank', 'requestedModel'], consumes: ['rerankDialect'] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http'] },
  async execute({ rerankDialect, ...facts }, scope) {
    const invalid = (message: string) => {
      scope.services.dump?.error('gateway');
      return { http: jsonResponse(localHead(400), openAIError(message)) };
    };
    let value: unknown;
    try {
      value = JSON.parse(decodeRequestBody(facts.http));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return invalid('Rerank request body must be valid JSON');
    }

    let parsed: ReturnType<typeof parseRerankRequest>;
    try {
      parsed = parseRerankRequest(rerankDialect, value);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return invalid(error.message);
    }

    scope.services.dump?.requestedModel(parsed.model);
    return await scope.next({ ...facts, rerank: parsed.request, requestedModel: parsed.model });
  },
});
