import { encodeOpenAICompletions } from './encode.ts';
import { includeOpenAICompletionsUsage } from './include-usage.ts';
import { openaiCompletionsError, parseOpenAICompletions } from './parse.ts';
import { computeOpenAICompletionsUsage } from './usage.ts';
import { stripAuthenticationHeaders } from '../pipeline/auth-headers.ts';
import { discoverCandidates } from '../pipeline/discover-candidates.ts';
import { localResponseHead } from '../pipeline/encode.ts';
import { compose } from '../pipeline/facts.ts';
import { failover } from '../pipeline/failover.ts';
import { measurePerformance } from '../pipeline/performance.ts';
import { providerTargets } from '../pipeline/provider-targets.ts';
import { storeUsage } from '../pipeline/store-usage.ts';
import { appendFailedUpstreams } from '../shared/failed-upstreams.ts';

const operation = 'openaiCompletions';

export const openaiCompletionsPipeline = compose(operation, {
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
    parseOpenAICompletions,
    encodeOpenAICompletions,
    includeOpenAICompletionsUsage,
    discoverCandidates(operation, {
      kind: 'chat',
      model: payload => payload.model,
      supports: model => model.endpoints.openaiCompletions !== undefined,
      unavailable({ model, exists, failedUpstreams }) {
        const message = exists
          ? `Model ${model} does not support the /completions endpoint.`
          : `Model ${model} is not available on any configured upstream.`;
        return {
          http: { ...localResponseHead(exists ? 400 : 404), body: null },
          outcome: { kind: 'error', source: 'local', error: openaiCompletionsError(appendFailedUpstreams(message, failedUpstreams)) },
        };
      },
    }),
    failover(operation),
    measurePerformance(operation, 'text_completion'),
    storeUsage,
    computeOpenAICompletionsUsage,
  ],
  ...providerTargets(operation),
});
