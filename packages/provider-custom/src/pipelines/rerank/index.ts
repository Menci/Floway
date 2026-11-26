import { customOperation, jsonBody, openAIError } from '../dial.ts';
import { DEFAULT_RERANK_PATHS, parseRerankResponse, RerankResponseValidationError, serializeRerankRequest } from '@floway-dev/protocols/rerank';
import { parseResultResponse, type ProviderModelFact } from '@floway-dev/provider';

const targetOf = (model: ProviderModelFact) => {
  if (model.rerankTarget === undefined) throw new Error(`Rerank model ${model.id} has no outbound target`);
  return model.rerankTarget;
};

export const rerank = customOperation('rerank', {
  parse: parseResultResponse('rerank', {
    needs: ['request.rerank', 'provider.model'] as const,
    format: openAIError,
    decode(bytes, _http, facts) {
      const { protocol } = targetOf(facts['provider.model']);
      const request = facts['request.rerank'];
      try {
        const canonical = parseRerankResponse(protocol, JSON.parse(new TextDecoder().decode(bytes)));
        const invalid = canonical.results.find(({ index }) => index >= request.documents.length);
        if (invalid !== undefined) {
          return { ok: false, error: new Error(`Rerank response result index ${invalid.index} is outside the request documents array`) };
        }
        return { ok: true, value: request.sourceProtocol === protocol ? bytes : canonical };
      } catch (error) {
        if (!(error instanceof SyntaxError) && !(error instanceof RerankResponseValidationError)) throw error;
        return { ok: false, error };
      }
    },
  }),
  prepare: (payload, modelId, _config, model) => {
    const { protocol, path } = targetOf(model);
    return {
      path: path ?? DEFAULT_RERANK_PATHS[protocol],
      ...jsonBody(serializeRerankRequest(protocol, modelId, payload)),
    };
  },
});
