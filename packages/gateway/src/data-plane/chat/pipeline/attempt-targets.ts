import type { ChatAttemptTarget, ChatOperation } from './facts.ts';
import { hasProviderTarget } from './provider-targets.ts';
import type { Candidate } from '../../pipeline/facts.ts';
import { selectAffinityCandidates, type AffinityCandidate, type AffinityRequestAnalysis, type AffinitySelectionFailure } from '../shared/affinity/selection.ts';
import type { UpstreamRequestFacts } from '@floway-dev/upstream';

const preferences = {
  anthropicMessages: ['anthropicMessages', 'openaiResponses', 'openaiChatCompletions'],
  geminiGenerateContent: ['geminiGenerateContent', 'openaiChatCompletions', 'anthropicMessages', 'openaiResponses'],
  openaiChatCompletions: ['openaiChatCompletions', 'anthropicMessages', 'openaiResponses'],
  openaiResponses: ['openaiResponses', 'anthropicMessages', 'openaiChatCompletions'],
} as const satisfies Record<ChatOperation, readonly ChatOperation[]>;

export const pickChatTarget = (source: ChatOperation, { upstream, model }: Pick<Candidate, 'upstream' | 'model'>): ChatOperation | undefined =>
  preferences[source].find(target => Boolean(model.endpoints[target]) && hasProviderTarget(target, upstream.kind));

export const buildChatAttemptTargets = <Op extends ChatOperation>(
  source: Op,
  candidates: readonly Candidate[],
  affinity: AffinityRequestAnalysis<UpstreamRequestFacts[Op], AffinityCandidate>,
): readonly ChatAttemptTarget<Op>[] | AffinitySelectionFailure => {
  const available = candidates.flatMap(candidate => {
    const operation = pickChatTarget(source, candidate);
    return operation === undefined ? [] : [{
      candidate,
      operation,
      upstream: { upstreamId: candidate.upstream.id },
      model: candidate.model,
      ...(candidate.rules === undefined ? {} : { rules: candidate.rules }),
    } satisfies AffinityCandidate & { candidate: Candidate; operation: ChatOperation }];
  });
  const selected = selectAffinityCandidates(available, affinity);
  if ('kind' in selected) return selected;
  return selected.candidates.map(item => ({
    ...item.candidate,
    operation: item.operation,
    payload: selected.payloadFor(item),
  }));
};
