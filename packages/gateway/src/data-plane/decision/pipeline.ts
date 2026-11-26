import { encodeDecision } from './encode.ts';
import { decisionError, parseDecision } from './parse.ts';
import { computeDecisionUsage } from './usage.ts';
import { validateDecisionResponse } from './validate-response.ts';
import { stripAuthenticationHeaders } from '../pipeline/auth-headers.ts';
import { discoverCandidates } from '../pipeline/discover-candidates.ts';
import { localResponseHead } from '../pipeline/encode.ts';
import { compose } from '../pipeline/facts.ts';
import { failover } from '../pipeline/failover.ts';
import { measurePerformance } from '../pipeline/performance.ts';
import { providerTargets } from '../pipeline/provider-targets.ts';
import { storeUsage } from '../pipeline/store-usage.ts';
import { appendFailedUpstreams } from '../shared/failed-upstreams.ts';
import type { DecisionProtocol } from '@floway-dev/protocols/common';

const operation = 'decision';
const decisionPipeline = (dialect: DecisionProtocol) => compose(`${dialect}.decision`, {
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
    parseDecision(dialect),
    encodeDecision(dialect),
    validateDecisionResponse,
    discoverCandidates(operation, {
      kind: 'decision',
      model(payload) {
        const { model } = payload.raw;
        if (typeof model !== 'string') throw new TypeError('Expected the parsed decision model');
        return model;
      },
      supports: model => model.endpoints.decision !== undefined && model.decisionTarget !== undefined,
      unavailable({ model, exists, failedUpstreams }) {
        const message = exists
          ? `Model ${model} does not support decision.`
          : `Model ${model} is not available on any configured upstream.`;
        return {
          http: { ...localResponseHead(exists ? 400 : 404), body: null },
          outcome: { kind: 'error', source: 'local', error: decisionError(appendFailedUpstreams(message, failedUpstreams)) },
        };
      },
    }),
    failover(operation),
    measurePerformance(operation, 'decision'),
    storeUsage,
    computeDecisionUsage,
  ],
  ...providerTargets(operation),
});

export const decisionPipelines = {
  'typesafe-systemone': decisionPipeline('typesafe-systemone'),
  'openai-decisions': decisionPipeline('openai-decisions'),
};
