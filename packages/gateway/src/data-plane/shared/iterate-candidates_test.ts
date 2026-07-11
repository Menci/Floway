import { describe, expect, it } from 'vitest';

import { iterateCandidates } from './iterate-candidates.ts';
import type { ModelCandidate, PerformanceTelemetryContext } from '@floway-dev/provider';

const stubCandidate = (id: string): ModelCandidate =>
  ({ model: { id }, provider: { upstream: 'up' } } as unknown as ModelCandidate);

const stubTelemetry = (upstream: string): PerformanceTelemetryContext =>
  ({ upstream, model: { id: 'm', canonicalizedId: 'm' }, operation: 'chat' } as unknown as PerformanceTelemetryContext);

describe('iterateCandidates', () => {
  it('resets attempt to null/undefined at the start of every candidate attempt', async () => {
    const attempt = { upstreamCallStartedAt: 999, firstOutputTokenAt: 999, telemetry: stubTelemetry('carryover') as PerformanceTelemetryContext | undefined };
    const observed: Array<{ upstreamCallStartedAt: number | null; firstOutputTokenAt: number | null; telemetry: PerformanceTelemetryContext | undefined }> = [];

    await iterateCandidates(
      [stubCandidate('a'), stubCandidate('b'), stubCandidate('c')],
      'test',
      attempt,
      async candidate => {
        observed.push({
          upstreamCallStartedAt: attempt.upstreamCallStartedAt,
          firstOutputTokenAt: attempt.firstOutputTokenAt,
          telemetry: attempt.telemetry,
        });
        // simulate an attempt that stamps then fails, so the loop advances
        attempt.upstreamCallStartedAt = 100;
        attempt.firstOutputTokenAt = 200;
        attempt.telemetry = stubTelemetry(candidate.model.id);
        return candidate.model.id === 'c'
          ? { type: 'events' as const }
          : { type: 'api-error' as const };
      },
    );

    // Every attempt must observe cleared slots on entry — a prior candidate's
    // stamps (or the caller-supplied carryover) must not survive into the next
    // attempt. Regressing this reintroduces the mid-attempt-throw
    // misattribution the reset was added to prevent.
    expect(observed).toEqual([
      { upstreamCallStartedAt: null, firstOutputTokenAt: null, telemetry: undefined },
      { upstreamCallStartedAt: null, firstOutputTokenAt: null, telemetry: undefined },
      { upstreamCallStartedAt: null, firstOutputTokenAt: null, telemetry: undefined },
    ]);
  });

  it('returns the first success and stops iterating', async () => {
    const attempt = { upstreamCallStartedAt: null, firstOutputTokenAt: null, telemetry: undefined };
    let calls = 0;
    const result = await iterateCandidates(
      [stubCandidate('a'), stubCandidate('b'), stubCandidate('c')],
      'test',
      attempt,
      async () => {
        calls++;
        return { type: 'events' as const };
      },
    );

    expect(result).toEqual({ type: 'events' });
    expect(calls).toBe(1);
  });

  it('returns the last failure once every candidate errors', async () => {
    const attempt = { upstreamCallStartedAt: null, firstOutputTokenAt: null, telemetry: undefined };
    let index = 0;
    const failures = [
      { type: 'api-error' as const, marker: 'first' },
      { type: 'internal-error' as const, marker: 'last' },
    ];
    const result = await iterateCandidates(
      [stubCandidate('a'), stubCandidate('b')],
      'test',
      attempt,
      async () => failures[index++]!,
    );

    expect(result).toEqual(failures[1]);
  });

  it('treats non-2xx plain results as failure so the next candidate runs', async () => {
    const attempt = { upstreamCallStartedAt: null, firstOutputTokenAt: null, telemetry: undefined };
    const attempts: number[] = [];
    const result = await iterateCandidates(
      [stubCandidate('a'), stubCandidate('b')],
      'test',
      attempt,
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
