import { azureResourceRootUrl } from '../../endpoint.ts';
import { parseJsonObject } from '../parse-json-object.ts';
import { prepareRequest, upstreamConfig } from '../prepare-request.ts';
import { stripAzureHeaders } from '../strip-headers.ts';
import { factSpace, move, transform } from '@floway-dev/pipeline';
import { parseJSONWithRawNumbers } from '@floway-dev/protocols/common';
import { formatDecisionError, DEFAULT_DECISION_PATHS, parseDecisionResponse, serializeDecisionRequest } from '@floway-dev/protocols/decision';
import { httpTerminal, type ProviderOperationFacts, type ProviderTransportFacts, type ProviderServices, joinBaseAndPath, type ProviderModelFact, parseResultBody } from '@floway-dev/provider';

const { compose, defineStage } = factSpace<ProviderOperationFacts<'decision'> & ProviderTransportFacts, ProviderServices>();

const call = defineStage({
  name: 'azure.decision.call',
  through: {
    request: {
      needs: ['request.http', 'request.decision', 'provider.upstream', 'provider.model'],
      provides: ['request.http'],
      consumes: [],
    },
    response: {
      needs: ['response.transport'],
      provides: ['response.http', 'response.modelKey', 'response.decision'],
      consumes: ['response.transport'],
    },
  },
  execute: transform(() => {
    let modelKey: string;
    let target: NonNullable<ProviderModelFact['decisionTarget']>;
    return {
      request: facts => {
        const config = upstreamConfig(facts['provider.upstream']);
        const { upstreamModelId } = facts['provider.model'];
        modelKey = upstreamModelId;
        const { id, decisionTarget } = facts['provider.model'];
        if (decisionTarget === undefined) throw new Error(`Decision model ${id} has no outbound target`);
        target = decisionTarget;
        const path = target.path ?? DEFAULT_DECISION_PATHS[target.protocol];
        const body = serializeDecisionRequest(target.protocol, modelKey, facts['request.decision']);
        const request = prepareRequest(facts['request.http'], config, joinBaseAndPath(azureResourceRootUrl(config.endpoint), path), body);
        return { ...facts, 'request.http': move(request) };
      },
      response: async back => {
        const parse = (bytes: Uint8Array) => {
          const json = parseJsonObject(bytes, parseJSONWithRawNumbers);
          if (!json.ok) return json;
          try {
            return { ok: true, value: parseDecisionResponse(target.protocol, json.value) } as const;
          } catch (error) {
            return { ok: false, error } as const;
          }
        };
        const { http, outcome } = await parseResultBody(back, parse, formatDecisionError);
        const { 'response.transport': _transport, ...response } = back;
        return { ...response, 'response.http': move(http), 'response.modelKey': modelKey, 'response.decision': move(outcome) };
      },
    };
  }),
});

export const decision = compose('azure.decision', {
  entry: ['request.http', 'request.decision', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.decision'],
  stages: [stripAzureHeaders, call],
  ending: httpTerminal,
});
