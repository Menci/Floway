import { copilotOperation } from '../facts.ts';
import { authorize } from '../shared/authorize.ts';
import { dial, jsonRequest } from '../shared/dial.ts';
import { formatOpenAIError } from '../shared/format-errors.ts';
import { observeQuota } from '../shared/observe-quota.ts';
import { readJsonObject } from '../shared/read-json-object.ts';
import { selectModel } from '../shared/select-model.ts';
import { setIdentityHeaders } from '../shared/set-identity-headers.ts';
import { stripClientHeaders } from '../shared/strip-client-headers.ts';
import { decodeDecisionResponse, DEFAULT_DECISION_PATHS, serializeDecisionRequest } from '@floway-dev/protocols/decision';
import { httpTerminal, parseResultResponse, type ProviderModelFact } from '@floway-dev/provider';

const operation = 'decision';
const decisionTarget = (model: ProviderModelFact) => {
  if (model.decisionTarget === undefined) throw new Error(`Copilot decision model ${model.id} has no outbound target`);
  return model.decisionTarget;
};

const parse = parseResultResponse(operation, {
  needs: ['provider.model', 'request.decision'],
  format: formatOpenAIError,
  decode(bytes, _http, facts) {
    const body = readJsonObject(bytes);
    if (!body.ok) return body;
    const { protocol } = decisionTarget(facts['provider.model']);
    const result = decodeDecisionResponse(protocol, body.value);
    if (!result.ok) return result;
    return { ok: true, value: facts['request.decision'].sourceProtocol === protocol ? bytes : result.value };
  },
});

export const decision = copilotOperation<typeof operation>().compose('copilot.decision', {
  entry: ['request.http', 'provider.upstream', 'provider.model', 'request.decision'],
  exit: ['response.http', 'response.decision', 'response.usageModelKey?'],
  stages: [
    stripClientHeaders,
    selectModel.decision,
    setIdentityHeaders,
    parse,
    authorize(operation, formatOpenAIError),
    dial.decision((payload, model) => {
      const target = decisionTarget(model);
      const modelId = payload.raw.model;
      if (typeof modelId !== 'string') throw new TypeError('Copilot Decision requires a selected model');
      return jsonRequest(target.path ?? DEFAULT_DECISION_PATHS[target.protocol], serializeDecisionRequest(target.protocol, modelId, payload));
    }, formatOpenAIError),
    observeQuota,
  ],
  ending: httpTerminal,
});
