import { describe, expect, it } from 'vitest';

import { iterateCandidates } from './iterate-candidates.ts';
import type { ModelCandidate } from '@floway-dev/provider';

const stubCandidate = (id: string): ModelCandidate =>
  ({ model: { id }, provider: { upstream: 'up' } } as unknown as ModelCandidate);

describe('iterateCandidates', () => {
  it('resets perfTiming to null at the start of every candidate attempt', async () => {
    const perfTiming = { upstreamCallStartedAt: 999, firstOutputTokenAt: 999 };
    const observed: Array<{ upstreamCallStartedAt: number | null; firstOutputTokenAt: number | null }> = [];

    await iterateCandidates(
      [stubCandidate('a'), stubCandidate('b'), stubCandidate('c')],
      'test',
      perfTiming,
      async candidate => {
        observed.push({ ...perfTiming });
        // simulate an attempt that stamps then fails, so the loop advances
        perfTiming.upstreamCallStartedAt = 100;
        perfTiming.firstOutputTokenAt = 200;
        return candidate.model.id === 'c'
          ? { type: 'events' as const }
          : { type: 'api-error' as const };
      },
    );

    expect(observed).toEqual([
      { upstreamCallStartedAt: null, firstOutputTokenAt: null },
      { upstreamCallStartedAt: null, firstOutputTokenAt: null },
      { upstreamCallStartedAt: null, firstOutputTokenAt: null },
    ]);
  });

  it('returns the first success and stops iterating', async () => {
    const perfTiming = { upstreamCallStartedAt: null, firstOutputTokenAt: null };
    let calls = 0;
    const result = await iterateCandidates(
      [stubCandidate('a'), stubCandidate('b'), stubCandidate('c')],
      'test',
      perfTiming,
      async () => {
        calls++;
        return { type: 'events' as const };
      },
    );

    expect(result).toEqual({ type: 'events' });
    expect(calls).toBe(1);
  });

  it('returns the last failure once every candidate errors', async () => {
    const perfTiming = { upstreamCallStartedAt: null, firstOutputTokenAt: null };
    let index = 0;
    const failures = [
      { type: 'api-error' as const, marker: 'first' },
      { type: 'internal-error' as const, marker: 'last' },
    ];
    const result = await iterateCandidates(
      [stubCandidate('a'), stubCandidate('b')],
      'test',
      perfTiming,
      async () => failures[index++]!,
    );

    expect(result).toEqual(failures[1]);
  });

  it('treats non-2xx plain results as failure so the next candidate runs', async () => {
    const perfTiming = { upstreamCallStartedAt: null, firstOutputTokenAt: null };
    const attempts: number[] = [];
    const result = await iterateCandidates(
      [stubCandidate('a'), stubCandidate('b')],
      'test',
      perfTiming,
      async candidate => {
        attempts.push(attempts.length);
        return candidate.model.id === 'a'
          ? { type: 'plain' as const, status: 500 }
          : { type: 'plain' as const, status: 200 };
      },
    );

    expect(attempts).toEqual([0, 1]);
    expect(result).toEqual({ type: 'plain', status: 200 });
  });
});
