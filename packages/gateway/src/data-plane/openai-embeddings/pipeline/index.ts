import { openAIEmbeddingsDelivery } from './delivery.ts';
import { openAIEmbeddingsEgress } from './egress.ts';
import { openAIEmbeddingsError, parseOpenAIEmbeddings } from './parse.ts';
import { discoverCandidates } from '../../pipeline/discover-candidates.ts';
import { encodeResponse, renderJsonResult } from '../../pipeline/encode-response.ts';
import { gatewayFactSpace, httpEntry } from '../../pipeline/facts.ts';
import { failover } from '../../pipeline/failover.ts';
import { providerSupportsOperation } from '../../pipeline/provider-pipelines.ts';
import { requestBody } from '../../pipeline/request-body.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { stripFlowayAuth } from '../../pipeline/strip-floway-auth.ts';
import { appendFailedUpstreams } from '../../shared/failed-upstreams.ts';

const { compose } = gatewayFactSpace<GatewayServices>();

export const openAIEmbeddingsPipeline = compose('openaiEmbeddings.ingress', {
  entry: httpEntry,
  exit: ['response.http'],
  stages: [
    requestBody,
    stripFlowayAuth,
    openAIEmbeddingsDelivery,
    encodeResponse('response.openaiEmbeddings', renderJsonResult),
    parseOpenAIEmbeddings,
    discoverCandidates('embedding'),
    failover('response.openaiEmbeddings', (model, { sawModel, failedUpstreams }) => {
      const message = sawModel
        ? `Model ${model} does not support the /embeddings endpoint.`
        : `Model ${model} is not available on any configured upstream.`;
      return openAIEmbeddingsError(sawModel ? 400 : 404, appendFailedUpstreams(message, failedUpstreams));
    }, candidate => candidate.model.endpoints.openaiEmbeddings !== undefined && providerSupportsOperation(candidate.upstream.kind, 'openaiEmbeddings')),
    ...openAIEmbeddingsEgress.stages,
  ],
  ending: openAIEmbeddingsEgress.ending,
  targets: openAIEmbeddingsEgress.targets,
});
