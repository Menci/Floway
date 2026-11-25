import { rerankEgress } from './egress.ts';
import { parseRerank, rerankError } from './parse.ts';
import { renderRerank } from './render.ts';
import { discoverCandidates } from '../../pipeline/discover-candidates.ts';
import { encodeResponse } from '../../pipeline/encode-response.ts';
import { gatewayFactSpace, httpEntry } from '../../pipeline/facts.ts';
import { failover, type AttemptPreparation } from '../../pipeline/failover.ts';
import { providerSupportsOperation } from '../../pipeline/provider-pipelines.ts';
import { requestBody } from '../../pipeline/request-body.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { stripFlowayAuth } from '../../pipeline/strip-floway-auth.ts';
import { appendFailedUpstreams } from '../../shared/failed-upstreams.ts';
import type { RerankSourceProtocol } from '@floway-dev/protocols/common';
import { rerankRequestIncompatibility } from '@floway-dev/protocols/rerank';

const { compose } = gatewayFactSpace<GatewayServices>();

const prepare: AttemptPreparation<'request.rerank', 'response.rerank', {}> = {
  requestKey: 'request.rerank',
  async prepare(candidates, payload) {
    const reasons = new Set<string>();
    const targets = candidates.flatMap(candidate => {
      const { rerankTarget } = candidate.model;
      if (rerankTarget === undefined) throw new TypeError('A routable rerank model must declare its target');
      const reason = rerankRequestIncompatibility(rerankTarget.protocol, payload);
      if (reason === null) return [{ candidate, payload }];
      reasons.add(reason);
      return [];
    });
    return targets.length === 0 && reasons.size > 0
      ? { kind: 'unavailable', message: `Model ${String(payload.raw.model)} does not support this rerank request: ${[...reasons].join('; ')}.` }
      : { kind: 'targets', targets };
  },
  unavailable: message => rerankError(400, message),
};

export const createRerankPipeline = (protocol: RerankSourceProtocol) => compose('rerank.ingress', {
  entry: httpEntry,
  exit: ['response.http'],
  stages: [
    requestBody,
    stripFlowayAuth,
    parseRerank(protocol),
    encodeResponse('response.rerank', renderRerank),
    discoverCandidates('rerank'),
    failover('response.rerank', (model, { sawModel, failedUpstreams }) => {
      const message = sawModel
        ? `Model ${model} does not support rerank.`
        : `Model ${model} is not available on any configured upstream.`;
      return rerankError(sawModel ? 400 : 404, appendFailedUpstreams(message, failedUpstreams));
    }, candidate => candidate.model.endpoints.rerank !== undefined && candidate.model.rerankTarget !== undefined
      && providerSupportsOperation(candidate.upstream.kind, 'rerank'), prepare),
    ...rerankEgress.stages,
  ],
  ending: rerankEgress.ending,
  targets: rerankEgress.targets,
});
