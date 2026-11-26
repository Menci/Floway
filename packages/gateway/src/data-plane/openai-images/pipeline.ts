import { encodeOpenAIImagesEdits, encodeOpenAIImagesGenerations } from './encode.ts';
import { parseOpenAIImagesEdits } from './parse-edits.ts';
import { openaiImagesError, parseOpenAIImagesGenerations } from './parse-generations.ts';
import { computeOpenAIImagesEditsUsage, computeOpenAIImagesGenerationsUsage } from './usage.ts';
import { stripAuthenticationHeaders } from '../pipeline/auth-headers.ts';
import { discoverCandidates } from '../pipeline/discover-candidates.ts';
import { localResponseHead } from '../pipeline/encode.ts';
import { compose } from '../pipeline/facts.ts';
import { failover } from '../pipeline/failover.ts';
import { measurePerformance } from '../pipeline/performance.ts';
import { providerTargets } from '../pipeline/provider-targets.ts';
import { storeUsage } from '../pipeline/store-usage.ts';
import { appendFailedUpstreams } from '../shared/failed-upstreams.ts';

const entry = [
  'request.http',
  'request.auth.apiKeyId',
  'request.auth.userId',
  'request.auth.isAdmin',
  'request.auth.upstreamIds',
  'request.auth.randomizeUpstreams',
  'serve.runtimeLocation',
] as const;
const operationExit = ['response.http', 'response.candidate?', 'response.usage?', 'response.performance?', 'response.requestedModel?'] as const;
const exit = [...operationExit, 'response.outcome'] as const;

const modelUnavailable = (endpoint: string) => ({
  model,
  exists,
  failedUpstreams,
}: {
  model: string;
  exists: boolean;
  failedUpstreams: readonly string[];
}) => {
  const message = exists
    ? `Model ${model} does not support the ${endpoint} endpoint.`
    : `Model ${model} is not available on any configured upstream.`;
  return {
    http: { ...localResponseHead(exists ? 400 : 404), body: null },
    outcome: { kind: 'error' as const, source: 'local' as const, error: openaiImagesError(appendFailedUpstreams(message, failedUpstreams)) },
  };
};

const generations = 'openaiImagesGenerations';
const generationsStages = [
  discoverCandidates(generations, {
    kind: 'image',
    model: payload => payload.model,
    supports: model => model.endpoints.openaiImagesGenerations !== undefined,
    unavailable: modelUnavailable('/images/generations'),
  }),
  failover(generations),
  measurePerformance(generations, 'image_generation'),
  storeUsage,
  computeOpenAIImagesGenerationsUsage,
] as const;

export const openaiImagesGenerationsPipeline = compose(generations, {
  entry,
  exit,
  stages: [stripAuthenticationHeaders, parseOpenAIImagesGenerations, encodeOpenAIImagesGenerations, ...generationsStages],
  ...providerTargets(generations),
});

export const openaiImagesGenerationsOperation = compose(`${generations}.operation`, {
  entry: [...entry, 'request.openaiImagesGenerations'],
  exit: [...operationExit, 'response.openaiImagesGenerations'],
  stages: [stripAuthenticationHeaders, ...generationsStages],
  ...providerTargets(generations),
});

const edits = 'openaiImagesEdits';
const editsStages = [
  discoverCandidates(edits, {
    kind: 'image',
    model: 'request.model',
    supports: model => model.endpoints.openaiImagesEdits !== undefined,
    unavailable: modelUnavailable('/images/edits'),
  }),
  failover(edits),
  measurePerformance(edits, 'image_edit'),
  storeUsage,
  computeOpenAIImagesEditsUsage,
] as const;

export const openaiImagesEditsPipeline = compose(edits, {
  entry,
  exit,
  stages: [stripAuthenticationHeaders, parseOpenAIImagesEdits, encodeOpenAIImagesEdits, ...editsStages],
  ...providerTargets(edits),
});

export const openaiImagesEditsOperation = compose(`${edits}.operation`, {
  entry: [...entry, 'request.model', 'request.openaiImagesEdits'],
  exit: [...operationExit, 'response.openaiImagesEdits'],
  stages: [stripAuthenticationHeaders, ...editsStages],
  ...providerTargets(edits),
});
