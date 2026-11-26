import type { AffinityCodec } from './carrier.ts';
import { selectAffinityTargets, type AffinityRequestAnalysis } from './selection.ts';
import { defineOperationStage, type AttemptTarget, type Candidate, type GatewayPipelineFacts } from '../../../pipeline/facts.ts';
import type { HttpResponseFact } from '@floway-dev/http';
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
