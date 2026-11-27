import { defineStage } from './facts.ts';
import { encodedResponse, errorResponse, jsonResponse } from '../shared/http.ts';
import { getHeader } from '@floway-dev/http';
import { renderRerankResponse } from '@floway-dev/protocols/rerank';

export const encode = defineStage({
  name: 'rerank.encode',
  through: {
    request: { needs: ['rerank'], provides: [], consumes: [] },
    response: { needs: ['http', 'rerank', 'rerankTargetDialect?'], provides: ['http'], consumes: ['rerank', 'rerankTargetDialect'] },
  },
  async execute(facts, scope) {
    const { http, rerank, rerankTargetDialect, ...answer } = await scope.next(facts);
    if (rerank.kind === 'error') return { ...answer, http: errorResponse(http, rerank) };
    if (http === null) throw new Error('A rerank result requires an HTTP response');
    const { result } = rerank;
    if (result instanceof Uint8Array) {
      return { ...answer, http: encodedResponse(http, result, getHeader(http.headers, 'content-type') === undefined ? 'application/json' : undefined) };
    }
    if (rerankTargetDialect === undefined) throw new Error('A cross-dialect rerank result requires its provider dialect');
    return { ...answer, http: jsonResponse(http, renderRerankResponse(facts.rerank.sourceProtocol, rerankTargetDialect, result, facts.rerank)) };
  },
});
