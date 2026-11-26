import { dial, decisionTarget } from './dial.ts';
import { selectModel } from './select-model.ts';
import { copilotOperation } from '../facts.ts';
import { authorize } from '../shared/authorize.ts';
import { formatOpenAIError } from '../shared/format-errors.ts';
import { observeQuota } from '../shared/observe-quota.ts';
import { readJsonObject } from '../shared/read-json-object.ts';
import { setIdentityHeaders } from '../shared/set-identity-headers.ts';
import { stripClientHeaders } from '../shared/strip-client-headers.ts';
import { decodeDecisionResponse } from '@floway-dev/protocols/decision';
import { httpTerminal, parseResultResponse } from '@floway-dev/provider';

const operation = 'decision';
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
    selectModel,
    setIdentityHeaders,
    parse,
    authorize(operation, formatOpenAIError),
    dial,
    observeQuota,
  ],
  ending: httpTerminal,
});
