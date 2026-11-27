import parseHttpDate from 'http-dates';

import type { MeteredOutcome } from './compute-usage.ts';
import type { Candidate, SelectedCandidate } from './facts.ts';
import { getHeader, type HttpResponseFact } from '@floway-dev/http';
import type { Facts } from '@floway-dev/pipeline';

interface CandidateScope {
  readonly signal: AbortSignal;
  abort(call: Promise<unknown>): void;
  discard(answer: Facts): void;
}

interface CandidateFailure<Answer> {
  call: Promise<Answer>;
  answer: Answer;
  candidate: Candidate;
  retryAt: number | null;
}

// https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3
const retryAt = (http: HttpResponseFact | null): number | null => {
  if (http === null) return null;
  const header = getHeader(http.headers, 'retry-after');
  if (typeof header !== 'string' || header.trim() === '') return null;
  const value = header.trim();
  const now = Date.now();
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const time = now + Number(value) * 1000;
    return Number.isFinite(time) ? time : null;
  }
  try {
    return Math.max(now, parseHttpDate(value).getTime());
  } catch {
    // http-dates signals a malformed upstream header by throwing.
    return null;
  }
};

const identifyCandidate = ({ upstream, model }: Candidate): SelectedCandidate => ({
  upstreamId: upstream.id,
  model: model.id,
});

export const selectCandidate = async <Target extends Candidate, Answer extends Facts & { http: HttpResponseFact | null }>(
  candidates: readonly Target[],
  scope: CandidateScope,
  start: (candidate: Target) => Promise<Answer>,
  outcome: (answer: Answer) => Pick<MeteredOutcome, 'kind'>,
): Promise<Answer & { candidate: SelectedCandidate }> => {
  let retained: CandidateFailure<Answer> | undefined;
  const discard = ({ call, answer }: CandidateFailure<Answer>): void => {
    scope.abort(call);
    scope.discard(answer);
  };
  try {
    for (const candidate of candidates) {
      if (retained !== undefined && scope.signal.aborted) break;
      const call = start(candidate);
      const answer = await call;
      if (outcome(answer).kind !== 'error') return { ...answer, candidate: identifyCandidate(candidate) };

      const failure = { call, answer, candidate, retryAt: retryAt(answer.http) };
      if (retained?.retryAt != null && (failure.retryAt === null || retained.retryAt <= failure.retryAt)) {
        discard(failure);
      } else {
        if (retained !== undefined) discard(retained);
        retained = failure;
      }
    }
    if (retained === undefined) throw new Error('Failover requires at least one candidate');
    const { answer, candidate } = retained;
    retained = undefined;
    return { ...answer, candidate: identifyCandidate(candidate) };
  } finally {
    if (retained !== undefined) discard(retained);
  }
};
