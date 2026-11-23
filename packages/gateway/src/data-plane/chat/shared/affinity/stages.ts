import type { AffinityEgressOptions } from './carrier.ts';
import { type AffinityAnalysis, affinityIdentityForCandidate, candidateSatisfiesAffinityIdentity, type EvaluateAffinity, type ScoreAffinity } from './selection.ts';
import type { HttpInput } from '../../../pipeline/edge-http.ts';
import type { CandidateRequest } from '../../../pipeline/failover.ts';
import type { CandidateError } from '../../../pipeline/resolve-candidates.ts';
import type { GatewayServices, RouteCandidate } from '../../../pipeline/services.ts';
import type { ChatEvent, ChatOutcomeFacts, ChatPayload, ChatPayloadFacts } from '../route-body.ts';
import { wrapProtocolFrames } from '../stream-frames.ts';
import type { ChatTargetPicker } from '../target-picker.ts';
import { defineStage } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ChatTargetApi } from '@floway-dev/provider';

type AffinityServices = Pick<GatewayServices, 'affinityCodec'>;
export interface AffinityFacts<Analysis extends AffinityAnalysis> {
  readonly 'request.affinity': Analysis;
}

interface AffinityRoutingFailure extends CandidateError {
  readonly kind: 'routing-unavailable';
}

export const isAffinityRoutingFailure = (error: CandidateError): error is AffinityRoutingFailure =>
  'kind' in error && error.kind === 'routing-unavailable';

export const createAnalyzeAffinity = <Api extends ChatTargetApi, Analysis extends AffinityAnalysis, Payload = ChatPayload<Api>>(
  api: Api,
  analyze: (payload: Payload, codec: AffinityServices['affinityCodec']) => Promise<Analysis>,
) => {
  type Request = ChatPayloadFacts<Api, Payload>;
  type Down = Request & AffinityFacts<Analysis>;
  const key = `request.${api}` as const;
  return defineStage<Request, Down, object, object, AffinityServices>({
    name: 'analyzeAffinity',
    through: {
      request: { needs: [key], consumes: [], provides: ['request.affinity'] },
      response: { needs: [], consumes: [], provides: [] },
    },
    execute: async (facts, scope) => {
      const analysis = await analyze(facts[key], scope.services.affinityCodec);
      return await scope.next({ ...facts, 'request.affinity': analysis });
    },
  });
};

export const createAffinity = <
  Api extends ChatTargetApi,
  Analysis extends AffinityAnalysis,
  Payload extends object = ChatPayload<Api>,
  Event = ChatEvent<Api>,
>(api: Api, options: {
  readonly evaluate: EvaluateAffinity<Analysis, Payload>;
  readonly wrap?: (
    source: AsyncIterable<ProtocolFrame<Event>>,
    options: AffinityEgressOptions,
    request: HttpInput & CandidateRequest,
  ) => AsyncIterable<ProtocolFrame<Event>>;
}) => {
  type Request = ChatPayloadFacts<Api, Payload> & AffinityFacts<Analysis> & CandidateRequest & HttpInput;
  type Response = ChatOutcomeFacts<Api, Event>;
  const requestKey = `request.${api}` as const;
  const responseKey = `response.${api}` as const;
  const { wrap } = options;
  const responseKeys = wrap === undefined ? [] : [responseKey];
  return defineStage<Request, CandidateRequest, Response, Response, AffinityServices>({
    name: 'affinity',
    through: {
      request: { needs: [requestKey, 'request.affinity', 'route.candidate', 'request.http'], consumes: ['request.affinity'], provides: [requestKey] },
      response: { needs: responseKeys, consumes: [], provides: responseKeys },
    },
    execute: async (request, scope) => {
      const { 'request.affinity': analysis, ...facts } = request;
      const candidate = facts['route.candidate'];
      const evaluation = options.evaluate(analysis, candidate, request[requestKey]);
      if (evaluation.kind === 'rejected') throw new Error('Rejected affinity candidate reached an attempt');
      const payload = { ...evaluation.payload, model: candidate.modelId };
      const response = await scope.next({ ...facts, [requestKey]: payload });
      if (wrap === undefined) return response;
      const outcome = response[responseKey];
      if (outcome.kind !== 'stream') return response;
      const carrier = { codec: scope.services.affinityCodec, affinity: affinityIdentityForCandidate(candidate) };
      return {
        ...response,
        [responseKey]: { kind: 'stream', events: wrapProtocolFrames(outcome.events, scope, `${api} affinity`, source => wrap(source, carrier, request)) },
      };
    },
  });
};

export const selectChatCandidates = <Analysis extends AffinityAnalysis, Payload>(
  candidates: readonly RouteCandidate[],
  picker: ChatTargetPicker,
  analysis: Analysis,
  payload: Payload,
  score: ScoreAffinity<Analysis, Payload>,
  model: string,
): readonly RouteCandidate[] | AffinityRoutingFailure => {
  const { requiredTargets } = analysis;
  const unavailable = (message: string): AffinityRoutingFailure => ({ kind: 'routing-unavailable', status: 400, message, model, failedUpstreams: [] });
  if (requiredTargets.length > 1) {
    return unavailable(`Client-carried state requires multiple incompatible targets: ${requiredTargets.map(target => `'${target.upstreamId}/${target.modelId}'`).join(', ')}.`);
  }
  const preferred: RouteCandidate[] = [];
  const compatible: RouteCandidate[] = [];
  const degrading: RouteCandidate[] = [];
  for (const candidate of candidates) {
    if (!picker.canServe(candidate.endpoints, candidate.kind)) continue;
    const evaluation = score(analysis, candidate, payload);
    if ((evaluation.kind === 'accepted') !== requiredTargets.every(target => candidateSatisfiesAffinityIdentity(candidate, target))) {
      throw new Error('Affinity candidate evaluation disagrees with the request requirement analysis');
    }
    if (evaluation.kind === 'rejected') continue;
    if (evaluation.degrades) degrading.push(candidate);
    else if (evaluation.preferred === false) compatible.push(candidate);
    else preferred.push(candidate);
  }
  if (requiredTargets.length === 1 && preferred.length === 0 && compatible.length === 0 && degrading.length === 0) {
    const [required] = requiredTargets;
    return unavailable(`Client-carried state requires unavailable target '${required.upstreamId}/${required.modelId}'.`);
  }
  return [...preferred, ...compatible, ...degrading];
};
