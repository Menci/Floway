import { encodeOpenAIEmbeddings } from './encode.ts';
import { embeddingsError, parseOpenAIEmbeddings } from './parse.ts';
import { computeOpenAIEmbeddingsUsage } from './usage.ts';
import { stripAuthenticationHeaders } from '../pipeline/auth-headers.ts';
import { discoverCandidates } from '../pipeline/discover-candidates.ts';
import { localResponseHead } from '../pipeline/encode.ts';
import { compose } from '../pipeline/facts.ts';
import { failover } from '../pipeline/failover.ts';
import { measurePerformance } from '../pipeline/performance.ts';
import { providerTargets } from '../pipeline/provider-targets.ts';
import { storeUsage } from '../pipeline/store-usage.ts';
import { appendFailedUpstreams } from '../shared/failed-upstreams.ts';

const operation = 'openaiEmbeddings';

export const openaiEmbeddingsPipeline = compose(operation, {
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
    parseOpenAIEmbeddings,
    encodeOpenAIEmbeddings,
    discoverCandidates(operation, {
      kind: 'embedding',
      model: payload => payload.model,
      supports: model => model.endpoints.openaiEmbeddings !== undefined,
      unavailable({ model, exists, failedUpstreams }) {
        const message = exists
          ? `Model ${model} does not support the /embeddings endpoint.`
          : `Model ${model} is not available on any configured upstream.`;
        return {
          http: { ...localResponseHead(exists ? 400 : 404), body: null },
          outcome: { kind: 'error', source: 'local', error: embeddingsError(appendFailedUpstreams(message, failedUpstreams)) },
        };
      },
    }),
    failover(operation),
    measurePerformance(operation, 'embeddings'),
    storeUsage,
    computeOpenAIEmbeddingsUsage,
  ],
  ...providerTargets(operation),
});
