import { openAIImagesGenerationsEgress } from './egress.ts';
import { openAIImagesGenerationsError, parseOpenAIImagesGenerations } from './parse.ts';
import { discoverCandidates } from '../../../pipeline/discover-candidates.ts';
import { encodeResponse, renderJsonResult } from '../../../pipeline/encode-response.ts';
import { gatewayFactSpace, httpEntry } from '../../../pipeline/facts.ts';
import { failover } from '../../../pipeline/failover.ts';
import { providerSupportsOperation } from '../../../pipeline/provider-pipelines.ts';
import { requestBody } from '../../../pipeline/request-body.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import { stripFlowayAuth } from '../../../pipeline/strip-floway-auth.ts';
import { appendFailedUpstreams } from '../../../shared/failed-upstreams.ts';
import { openAIImagesDelivery } from '../delivery.ts';

const { compose } = gatewayFactSpace<GatewayServices>();

export const openAIImagesGenerationsPipeline = compose('openaiImagesGenerations.ingress', {
  entry: httpEntry,
  exit: ['response.http'],
  stages: [
    requestBody,
    stripFlowayAuth,
    openAIImagesDelivery('openaiImagesGenerations'),
    encodeResponse('response.openaiImagesGenerations', renderJsonResult),
    parseOpenAIImagesGenerations,
    discoverCandidates('image'),
    failover('response.openaiImagesGenerations', (model, { sawModel, failedUpstreams }) => {
      const message = sawModel
        ? `Model ${model} does not support the /images/generations endpoint.`
        : `Model ${model} is not available on any configured upstream.`;
      return openAIImagesGenerationsError(sawModel ? 400 : 404, appendFailedUpstreams(message, failedUpstreams));
    }, candidate => candidate.model.endpoints.openaiImagesGenerations !== undefined && providerSupportsOperation(candidate.upstream.kind, 'openaiImagesGenerations')),
    ...openAIImagesGenerationsEgress.stages,
  ],
  ending: openAIImagesGenerationsEgress.ending,
  targets: openAIImagesGenerationsEgress.targets,
});
