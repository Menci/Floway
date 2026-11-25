import { openAIImagesGenerationsEgress } from './egress.ts';
import { openAIImagesGenerationsError, parseOpenAIImagesGenerations } from './parse.ts';
import { discoverCandidates } from '../../../pipeline/discover-candidates.ts';
import { encodeResponse } from '../../../pipeline/encode-response.ts';
import { gatewayFactSpace, httpEntry, type ServeCandidates } from '../../../pipeline/facts.ts';
import { failover } from '../../../pipeline/failover.ts';
import { providerSupportsOperation } from '../../../pipeline/provider-pipelines.ts';
import { requestBody } from '../../../pipeline/request-body.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import { stripFlowayAuth } from '../../../pipeline/strip-floway-auth.ts';
import { appendFailedUpstreams } from '../../../shared/failed-upstreams.ts';
import { renderOpenAIImages } from '../encode-response.ts';

const { compose } = gatewayFactSpace<GatewayServices>();

const unavailable = (model: string, { sawModel, failedUpstreams }: ServeCandidates) => {
  const message = sawModel
    ? `Model ${model} does not support the /images/generations endpoint.`
    : `Model ${model} is not available on any configured upstream.`;
  return openAIImagesGenerationsError(sawModel ? 400 : 404, appendFailedUpstreams(message, failedUpstreams));
};

const dispatch = (error: typeof unavailable) => [
  discoverCandidates('image'),
  failover('response.openaiImagesGenerations', error,
    candidate => candidate.model.endpoints.openaiImagesGenerations !== undefined && providerSupportsOperation(candidate.upstream.kind, 'openaiImagesGenerations')),
  ...openAIImagesGenerationsEgress.stages,
];

export const createOpenAIImagesGenerationsBody = (error: typeof unavailable) => compose('openaiImagesGenerations.body', {
  entry: [...httpEntry, 'request.openaiImagesGenerations', 'serve.model'],
  exit: ['response.http', 'response.openaiImagesGenerations'],
  stages: dispatch(error),
  ending: openAIImagesGenerationsEgress.ending,
  targets: openAIImagesGenerationsEgress.targets,
});

export const openAIImagesGenerationsPipeline = compose('openaiImagesGenerations.ingress', {
  entry: httpEntry,
  exit: ['response.http'],
  stages: [
    requestBody,
    stripFlowayAuth,
    parseOpenAIImagesGenerations,
    encodeResponse('response.openaiImagesGenerations', renderOpenAIImages),
    ...dispatch(unavailable),
  ],
  ending: openAIImagesGenerationsEgress.ending,
  targets: openAIImagesGenerationsEgress.targets,
});
