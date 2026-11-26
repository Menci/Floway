import { encodeRerank } from './encode.ts';
import { parseRerank, rerankError } from './parse.ts';
import { computeRerankUsage } from './usage.ts';
import { stripAuthenticationHeaders } from '../pipeline/auth-headers.ts';
import { discoverCandidates } from '../pipeline/discover-candidates.ts';
import { localResponseHead } from '../pipeline/encode.ts';
import { compose } from '../pipeline/facts.ts';
import { failover } from '../pipeline/failover.ts';
import { measurePerformance } from '../pipeline/performance.ts';
import { providerTargets } from '../pipeline/provider-targets.ts';
import { storeUsage } from '../pipeline/store-usage.ts';
import { appendFailedUpstreams } from '../shared/failed-upstreams.ts';
import type { RerankSourceProtocol } from '@floway-dev/protocols/common';
import { rerankRequestIncompatibility } from '@floway-dev/protocols/rerank';

const operation = 'rerank';
const rerankPipeline = (dialect: RerankSourceProtocol) => compose(`${dialect}.rerank`, {
  entry: [
    'request.http',
    'request.auth.apiKeyId',
    'request.auth.userId',
    'request.auth.isAdmin',
    'request.auth.upstreamIds',
    'request.auth.randomizeUpstreams',
    'serve.runtimeLocation',
  ],
  exit: ['response.http', 'response.candidate?', 'response.usage?', 'response.performance?', 'response.outcome', 'response.requestedModel?'],
  stages: [
    stripAuthenticationHeaders,
    parseRerank(dialect),
    encodeRerank,
    discoverCandidates(operation, {
      kind: 'rerank',
      model(payload) {
        const { model } = payload.raw;
        if (typeof model !== 'string') throw new TypeError('Expected the parsed rerank model');
        return model;
      },
      supports: model => model.endpoints.rerank !== undefined && model.rerankTarget !== undefined,
      incompatibility(model, payload) {
        if (model.rerankTarget === undefined) throw new Error(`Rerank model ${model.id} has no outbound target`);
        return rerankRequestIncompatibility(model.rerankTarget.protocol, payload);
      },
      unavailable({ model, exists, failedUpstreams, incompatibilities }) {
        if (incompatibilities.length > 0) {
          return {
            http: { ...localResponseHead(400), body: null },
            outcome: {
              kind: 'error',
              source: 'local',
              error: rerankError(`Model ${model} does not support this rerank request: ${incompatibilities.join('; ')}.`),
            },
          };
        }
        const message = exists
          ? `Model ${model} does not support rerank.`
          : `Model ${model} is not available on any configured upstream.`;
        return {
          http: { ...localResponseHead(exists ? 400 : 404), body: null },
          outcome: { kind: 'error', source: 'local', error: rerankError(appendFailedUpstreams(message, failedUpstreams)) },
        };
      },
    }),
    failover(operation),
    measurePerformance(operation, 'rerank'),
    storeUsage,
    computeRerankUsage(dialect),
  ],
  ...providerTargets(operation),
});

export const rerankPipelines = {
  'cohere-v1': rerankPipeline('cohere-v1'),
  'cohere-v2': rerankPipeline('cohere-v2'),
  'jina-v1': rerankPipeline('jina-v1'),
  'voyage-v1': rerankPipeline('voyage-v1'),
};
