import { affinityIdentityForCandidate, type AffinityEgressOptions } from './context.ts';
import { defineOperationStage, type Candidate, type OperationEvent } from '../../../pipeline/facts.ts';
import type { ChatOperation, ChatOutcome } from '../pipeline.ts';
import { wrapChatFrames } from '../translate.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

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
