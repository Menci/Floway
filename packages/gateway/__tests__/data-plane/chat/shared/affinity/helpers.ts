import type { AffinityCodec, AffinityRequestAnalysis, CandidateAffinityEvaluation } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import type { ModelCandidate } from '@floway-dev/provider';

export interface DeferredAffinityWrapCall {
  readonly value: string | undefined;
  readonly resolve: (value: string) => void;
}

export interface DeferredAffinityCodec extends Pick<AffinityCodec, 'wrap'> {
  readonly calls: DeferredAffinityWrapCall[];
  readonly nextCall: () => Promise<DeferredAffinityWrapCall>;
}

export const createDeferredAffinityCodec = (): DeferredAffinityCodec => {
  const calls: DeferredAffinityWrapCall[] = [];
  const waiters: Array<(call: DeferredAffinityWrapCall) => void> = [];
  let nextCallIndex = 0;

  const wrap = (value: string | undefined): Promise<string> => {
    let resolve!: (wrapped: string) => void;
    const promise = new Promise<string>(resolvePromise => {
      resolve = resolvePromise;
    });
    const call = { value, resolve };
    calls.push(call);
    waiters.shift()?.(call);
    return promise;
  };

  const nextCall = (): Promise<DeferredAffinityWrapCall> => {
    const call = calls[nextCallIndex];
    nextCallIndex += 1;
    return call === undefined
      ? new Promise(resolve => waiters.push(resolve))
      : Promise.resolve(call);
  };

  return { calls, nextCall, wrap };
};

export const acceptedAffinityEvaluation = <T>(
  analysis: AffinityRequestAnalysis<T>,
  candidate: ModelCandidate,
): Extract<CandidateAffinityEvaluation<T>, { kind: 'accepted' }> => {
  const evaluation = analysis.evaluateCandidate(candidate);
  if (evaluation.kind === 'rejected') {
    throw new Error('Expected accepted affinity candidate');
  }
  return evaluation;
};
