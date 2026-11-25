import { applyIngressHeaderRules } from '../apply-ingress-header-rules.ts';
import { parseJsonObject } from '../parse-json-object.ts';
import { prepareRequest, upstreamConfig } from '../prepare-request.ts';
import { factSpace, move, transform } from '@floway-dev/pipeline';
import { formatRerankError, DEFAULT_RERANK_PATHS, parseRerankResponse, serializeRerankRequest, type CanonicalRerankRequest } from '@floway-dev/protocols/rerank';
import { httpTerminal, type ProviderOperationFacts, type ProviderTransportFacts, type ProviderServices, type ProviderModelFact, parseResultBody } from '@floway-dev/provider';

const { compose, defineStage } = factSpace<ProviderOperationFacts<'rerank'> & ProviderTransportFacts, ProviderServices>();

const call = defineStage({
  name: 'custom.rerank.call',
  through: {
    request: {
      needs: ['request.http', 'request.rerank', 'provider.upstream', 'provider.model'],
      provides: ['request.http'],
      consumes: [],
    },
    response: {
      needs: ['response.transport'],
      provides: ['response.http', 'response.modelKey', 'response.rerank'],
      consumes: ['response.transport'],
    },
  },
  execute: transform(() => {
    let modelKey: string;
    let target: NonNullable<ProviderModelFact['rerankTarget']>;
    let payload: CanonicalRerankRequest;
    return {
      request: facts => {
        const config = upstreamConfig(facts['provider.upstream']);
        const { upstreamModelId } = facts['provider.model'];
        modelKey = upstreamModelId;
        const { id, rerankTarget } = facts['provider.model'];
        if (rerankTarget === undefined) throw new Error(`Rerank model ${id} has no outbound target`);
        target = rerankTarget;
        payload = facts['request.rerank'];
        const path = target.path ?? DEFAULT_RERANK_PATHS[target.protocol];
        const body = serializeRerankRequest(target.protocol, modelKey, payload);
        const request = prepareRequest(facts['request.http'], config, path, body);
        return { ...facts, 'request.http': move(request) };
      },
      response: async back => {
        let invalidBody: Record<string, unknown> | undefined;
        const parse = (bytes: Uint8Array) => {
          const json = parseJsonObject(bytes);
          if (!json.ok) return json;
          try {
            const value = parseRerankResponse(target.protocol, json.value);
            if (value.targetProtocol !== payload.sourceProtocol && payload.returnDocuments === true) {
              const invalid = value.results.find(({ index }) => payload.documents[index] === undefined);
              if (invalid !== undefined) throw new Error(`Rerank response result index ${invalid.index} is outside the request documents array`);
            }
            return { ok: true, value } as const;
          } catch (error) {
            invalidBody = json.value;
            return { ok: false, error } as const;
          }
        };
        const { http, outcome } = await parseResultBody(back, parse, formatRerankError);
        const { 'response.transport': _transport, ...response } = back;
        return {
          ...response,
          'response.http': move(http),
          'response.modelKey': modelKey,
          'response.rerank': move(outcome.kind === 'error' && invalidBody !== undefined ? { ...outcome, error: invalidBody } : outcome),
        };
      },
    };
  }),
});

export const rerank = compose('custom.rerank', {
  entry: ['request.http', 'request.rerank', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.rerank'],
  stages: [applyIngressHeaderRules, call],
  ending: httpTerminal,
});
