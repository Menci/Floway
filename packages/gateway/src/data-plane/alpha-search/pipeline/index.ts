import { alphaSearchDelivery } from './delivery.ts';
import { alphaSearchEgress } from './egress.ts';
import { alphaSearchModelNotFound, parseAlphaSearch } from './parse.ts';
import { routeAlphaSearch } from './route-search.ts';
import { discoverCandidates } from '../../pipeline/discover-candidates.ts';
import { encodeResponse, renderJsonResult } from '../../pipeline/encode-response.ts';
import { gatewayFactSpace, httpEntry } from '../../pipeline/facts.ts';
import { failover, type AttemptPreparation } from '../../pipeline/failover.ts';
import { providerSupportsOperation } from '../../pipeline/provider-pipelines.ts';
import { requestBody } from '../../pipeline/request-body.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { stripFlowayAuth } from '../../pipeline/strip-floway-auth.ts';

const { compose } = gatewayFactSpace<GatewayServices>();

const configuredTarget: AttemptPreparation<'request.alphaSearch', 'response.alphaSearch', {}> = {
  requestKey: 'request.alphaSearch',
  async prepare([candidate], payload) {
    if (candidate === undefined) return { kind: 'targets', targets: [] };
    if (!providerSupportsOperation(candidate.upstream.kind, 'alphaSearch')) {
      throw new Error('Selected upstream does not support OpenAI search');
    }
    return { kind: 'targets', targets: [{ candidate, payload }] };
  },
  unavailable: alphaSearchModelNotFound,
};

const dispatchStages = [
  routeAlphaSearch,
  discoverCandidates('chat'),
  failover('response.alphaSearch', alphaSearchModelNotFound, () => true, configuredTarget),
  ...alphaSearchEgress.stages,
];

export const alphaSearchBodyPipeline = compose('alphaSearch.body', {
  entry: [...httpEntry, 'request.alphaSearch'],
  exit: ['response.http', 'response.alphaSearch'],
  stages: dispatchStages,
  ending: alphaSearchEgress.ending,
  targets: alphaSearchEgress.targets,
});

export const alphaSearchPipeline = compose('alphaSearch.ingress', {
  entry: httpEntry,
  exit: ['response.http'],
  stages: [
    requestBody,
    stripFlowayAuth,
    alphaSearchDelivery,
    encodeResponse('response.alphaSearch', renderJsonResult),
    parseAlphaSearch,
    ...dispatchStages,
  ],
  ending: alphaSearchEgress.ending,
  targets: alphaSearchEgress.targets,
});
