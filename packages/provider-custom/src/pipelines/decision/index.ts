import { customOperation, jsonBody, openAIError } from '../dial.ts';
import { parseJsonObject } from '../parse-json-object.ts';
import { DEFAULT_DECISION_PATHS, decodeDecisionResponse, serializeDecisionRequest } from '@floway-dev/protocols/decision';
import { parseResultResponse, type ProviderModelFact } from '@floway-dev/provider';

const targetOf = (model: ProviderModelFact) => {
  if (model.decisionTarget === undefined) throw new Error(`Decision model ${model.id} has no outbound target`);
  return model.decisionTarget;
};

export const decision = customOperation('decision', {
  parse: parseResultResponse('decision', {
    needs: ['request.decision', 'provider.model'] as const,
    format: openAIError,
    decode(bytes, _http, facts) {
      const { protocol } = targetOf(facts['provider.model']);
      const parsed = parseJsonObject(bytes);
      if (!parsed.ok) return parsed;
      const decoded = decodeDecisionResponse(protocol, parsed.value);
      return decoded.ok && facts['request.decision'].sourceProtocol === protocol
        ? { ok: true, value: bytes }
        : decoded;
    },
  }),
  prepare: (payload, modelId, _config, model) => {
    const { protocol, path } = targetOf(model);
    return {
      path: path ?? DEFAULT_DECISION_PATHS[protocol],
      ...jsonBody(serializeDecisionRequest(protocol, modelId, payload)),
    };
  },
});
