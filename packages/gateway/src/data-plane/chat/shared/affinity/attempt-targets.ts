import type { AffinityCodec } from './carrier.ts';
import { affinityIdentityForCandidate, type AffinityEgressOptions } from './context.ts';
import { selectAffinityTargets, type AffinityRequestAnalysis } from './selection.ts';
import { defineOperationStage, type AttemptTarget, type Candidate, type GatewayPipelineFacts, type OperationEvent } from '../../../pipeline/facts.ts';
import type { ChatOperation, ChatOutcome } from '../pipeline.ts';
import { wrapChatFrames } from '../translate.ts';
import type { HttpResponseFact } from '@floway-dev/http';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ProtocolError, ProviderOperation } from '@floway-dev/provider';

type Payload<Op extends ProviderOperation> = GatewayPipelineFacts[`request.${Op}`];

export const buildAttemptTargets = <Op extends ProviderOperation>(
  operation: Op,
  analyze: (payload: Payload<Op>, codec: AffinityCodec) => Promise<AffinityRequestAnalysis<Payload<Op>>>,
  unavailable: (message: string) => { http: HttpResponseFact; outcome: ProtocolError },
) => {
  const payloadKey: string = `request.${operation}`;
  const outcomeKey: string = `response.${operation}`;
  const requestNeeds: readonly string[] = [payloadKey, 'request.candidates'];
  return defineOperationStage({
    name: `${operation}.build-attempt-targets`,
    through: {
      request: { needs: requestNeeds, provides: ['request.candidates'], consumes: [] },
      response: { needs: [], provides: [], consumes: [] },
    },
    return: { provides: ['response.http', outcomeKey] },
    async execute(facts, scope) {
      const affinity = await analyze(facts[payloadKey] as Payload<Op>, scope.services.affinity);
      const selection = selectAffinityTargets(facts['request.candidates'] as readonly Candidate[], affinity);
      if (selection.kind === 'routing-unavailable') {
        const failure = unavailable(selection.message);
        return { 'response.http': failure.http, [outcomeKey]: failure.outcome };
      }
      const targets: AttemptTarget<Op>[] = selection.targets.map(({ candidate, payload }) => ({ ...candidate, payload }));
      return await scope.next({ ...facts, 'request.candidates': targets });
    },
  });
};

export const affinityOutput = <Op extends ChatOperation>(
  operation: Op,
  transform: (frames: AsyncIterable<ProtocolFrame<OperationEvent<Op>>>, options: AffinityEgressOptions) => AsyncIterable<ProtocolFrame<OperationEvent<Op>>>,
) => {
  const outcomeKey: string = `response.${operation}`;
  const responseKeys: readonly string[] = [outcomeKey];
  return defineOperationStage({
    name: `${operation}.affinity-output`,
    through: {
      request: { needs: ['provider.model', 'provider.upstream', 'request.aliasRules?'], provides: [], consumes: [] },
      response: { needs: responseKeys, provides: responseKeys, consumes: [] },
    },
    async execute(facts, scope) {
      const answer = await scope.next(facts);
      const outcome = answer[outcomeKey] as ChatOutcome<Op>;
      if (outcome.kind !== 'stream') return answer;
      const rules = facts['request.aliasRules'] as Candidate['rules'];
      const affinity = affinityIdentityForCandidate({
        model: facts['provider.model'] as Candidate['model'],
        upstream: facts['provider.upstream'] as Candidate['upstream'],
        ...(rules === undefined ? {} : { rules }),
      });
      const codec = scope.services.affinity;
      const stream = wrapChatFrames(outcome.stream, scope, frames => transform(frames, { affinity, codec }));
      return { ...answer, [outcomeKey]: { kind: 'stream', stream } };
    },
  });
};
