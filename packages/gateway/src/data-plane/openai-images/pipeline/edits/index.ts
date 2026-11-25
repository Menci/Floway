import { openAIImagesEditsEgress } from './egress.ts';
import { openAIImagesEditsError, parseOpenAIImagesEdits } from './parse.ts';
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

export const openAIImagesEditsPipeline = compose('openaiImagesEdits.ingress', {
  entry: httpEntry,
  exit: ['response.http'],
  stages: [
    requestBody,
    stripFlowayAuth,
    openAIImagesDelivery('openaiImagesEdits'),
    encodeResponse('response.openaiImagesEdits', renderJsonResult),
    parseOpenAIImagesEdits,
    discoverCandidates('image'),
    failover('response.openaiImagesEdits', (model, { sawModel, failedUpstreams }) => {
      const message = sawModel
        ? `Model ${model} does not support the /images/edits endpoint.`
        : `Model ${model} is not available on any configured upstream.`;
      return openAIImagesEditsError(sawModel ? 400 : 404, appendFailedUpstreams(message, failedUpstreams));
    }, candidate => candidate.model.endpoints.openaiImagesEdits !== undefined && providerSupportsOperation(candidate.upstream.kind, 'openaiImagesEdits')),
    ...openAIImagesEditsEgress.stages,
  ],
  ending: openAIImagesEditsEgress.ending,
  targets: openAIImagesEditsEgress.targets,
});
