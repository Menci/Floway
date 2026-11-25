import { formatOpenAIError } from '../errors.ts';
import { parseJsonObject } from '../json-result.ts';
import { decodeDecisionResponse } from '@floway-dev/protocols/decision';
import { parseResultResponse } from '@floway-dev/provider';

// https://docs.ollama.com/capabilities/decision
export const parseResponse = parseResultResponse('decision', {
  needs: ['request.decision'],
  decode(bytes, _http, facts) {
    const parsed = parseJsonObject(bytes);
    if (!parsed.ok) return parsed;
    const decision = decodeDecisionResponse('typesafe-systemone', parsed.value);
    if (!decision.ok || facts['request.decision'].sourceProtocol !== 'typesafe-systemone') return decision;
    return { ok: true, value: bytes };
  },
  format: formatOpenAIError,
});
