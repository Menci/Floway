import { openAICompletionsEgress } from './egress.ts';
import { openAICompletionsError, parseOpenAICompletions } from './parse.ts';
import { renderOpenAICompletions } from './render.ts';
import { discoverCandidates } from '../../pipeline/discover-candidates.ts';
import { encodeResponse } from '../../pipeline/encode-response.ts';
import { gatewayFactSpace, httpEntry } from '../../pipeline/facts.ts';
import { failover } from '../../pipeline/failover.ts';
import { providerSupportsOperation } from '../../pipeline/provider-pipelines.ts';
import { requestBody } from '../../pipeline/request-body.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { stripFlowayAuth } from '../../pipeline/strip-floway-auth.ts';
import { appendFailedUpstreams } from '../../shared/failed-upstreams.ts';

const { compose } = gatewayFactSpace<GatewayServices>();

export const openAICompletionsPipeline = compose('openaiCompletions.ingress', {
  entry: httpEntry,
  exit: ['response.http'],
  stages: [
    requestBody,
    stripFlowayAuth,
    parseOpenAICompletions,
    encodeResponse('response.openaiCompletions', renderOpenAICompletions),
    discoverCandidates('chat'),
    failover('response.openaiCompletions', (model, { sawModel, failedUpstreams }) => {
      const message = sawModel
        ? `Model ${model} does not support the /completions endpoint.`
        : `Model ${model} is not available on any configured upstream.`;
      return openAICompletionsError(sawModel ? 400 : 404, appendFailedUpstreams(message, failedUpstreams));
    }, candidate => candidate.model.endpoints.openaiCompletions !== undefined && providerSupportsOperation(candidate.upstream.kind, 'openaiCompletions')),
    ...openAICompletionsEgress.stages,
  ],
  ending: openAICompletionsEgress.ending,
  targets: openAICompletionsEgress.targets,
});
