import { openAIImagesEditsEgress } from './egress.ts';
import { openAIImagesEditsError, parseOpenAIImagesEdits } from './parse.ts';
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
    ? `Model ${model} does not support the /images/edits endpoint.`
    : `Model ${model} is not available on any configured upstream.`;
  return openAIImagesEditsError(sawModel ? 400 : 404, appendFailedUpstreams(message, failedUpstreams));
};

const dispatch = (error: typeof unavailable) => [
  discoverCandidates('image'),
  failover('response.openaiImagesEdits', error,
    candidate => candidate.model.endpoints.openaiImagesEdits !== undefined && providerSupportsOperation(candidate.upstream.kind, 'openaiImagesEdits')),
  ...openAIImagesEditsEgress.stages,
];

export const createOpenAIImagesEditsBody = (error: typeof unavailable) => compose('openaiImagesEdits.body', {
  entry: [...httpEntry, 'request.openaiImagesEdits', 'serve.model'],
  exit: ['response.http', 'response.openaiImagesEdits'],
  stages: dispatch(error),
  ending: openAIImagesEditsEgress.ending,
  targets: openAIImagesEditsEgress.targets,
});

export const openAIImagesEditsPipeline = compose('openaiImagesEdits.ingress', {
  entry: httpEntry,
  exit: ['response.http'],
  stages: [
    requestBody,
    stripFlowayAuth,
    parseOpenAIImagesEdits,
    encodeResponse('response.openaiImagesEdits', renderOpenAIImages),
    ...dispatch(unavailable),
  ],
  ending: openAIImagesEditsEgress.ending,
  targets: openAIImagesEditsEgress.targets,
});
