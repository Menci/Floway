import { decisionEgress } from './egress.ts';
import { decisionError, parseDecision } from './parse.ts';
import { renderDecision } from './render.ts';
import { discoverCandidates } from '../../pipeline/discover-candidates.ts';
import { encodeResponse } from '../../pipeline/encode-response.ts';
import { gatewayFactSpace, httpEntry } from '../../pipeline/facts.ts';
import { failover } from '../../pipeline/failover.ts';
import { providerSupportsOperation } from '../../pipeline/provider-pipelines.ts';
import { requestBody } from '../../pipeline/request-body.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { stripFlowayAuth } from '../../pipeline/strip-floway-auth.ts';
import { appendFailedUpstreams } from '../../shared/failed-upstreams.ts';
import type { DecisionProtocol } from '@floway-dev/protocols/common';

const { compose } = gatewayFactSpace<GatewayServices>();

export const createDecisionPipeline = (protocol: DecisionProtocol) => compose('decision.ingress', {
  entry: httpEntry,
  exit: ['response.http'],
  stages: [
    requestBody,
    stripFlowayAuth,
    parseDecision(protocol),
    encodeResponse('response.decision', renderDecision),
    discoverCandidates('decision'),
    failover('response.decision', (model, { sawModel, failedUpstreams }) => {
      const message = sawModel
        ? `Model ${model} does not support decision.`
        : `Model ${model} is not available on any configured upstream.`;
      return decisionError(sawModel ? 400 : 404, appendFailedUpstreams(message, failedUpstreams));
    }, candidate => candidate.model.endpoints.decision !== undefined && candidate.model.decisionTarget !== undefined
      && providerSupportsOperation(candidate.upstream.kind, 'decision')),
    ...decisionEgress.stages,
  ],
  ending: decisionEgress.ending,
  targets: decisionEgress.targets,
});
