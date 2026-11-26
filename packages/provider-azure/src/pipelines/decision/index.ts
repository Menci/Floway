import { azureResourceRootUrl } from '../../endpoint.ts';
import { azureOperation, jsonBody, openAIError } from '../dial.ts';
import { parseJsonObject } from '../parse-json-object.ts';
import { DEFAULT_DECISION_PATHS, decodeDecisionResponse, serializeDecisionRequest } from '@floway-dev/protocols/decision';
import { joinBaseAndPath, parseResultResponse } from '@floway-dev/provider';

// https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision
const protocol = 'typesafe-systemone';

export const decision = azureOperation('decision', {
  parse: parseResultResponse('decision', {
    needs: ['request.decision'] as const,
    format: openAIError,
    decode(bytes, _http, facts) {
      const parsed = parseJsonObject(bytes);
      if (!parsed.ok) return parsed;
      const decoded = decodeDecisionResponse(protocol, parsed.value);
      return decoded.ok && facts['request.decision'].sourceProtocol === protocol
        ? { ok: true, value: bytes }
        : decoded;
    },
  }),
  prepare: (payload, modelId, endpoint) => ({
    url: joinBaseAndPath(azureResourceRootUrl(endpoint), DEFAULT_DECISION_PATHS[protocol]),
    ...jsonBody(serializeDecisionRequest(protocol, modelId, payload)),
  }),
});
