import { describe, expect, it } from 'vitest';

import { iterateCandidates } from './iterate-candidates.ts';
import { mockGatewayCtx } from '../../test-helpers/gateway-ctx.ts';
import type { GatewayCtx } from '../chat/shared/gateway-ctx.ts';
import type { ModelCandidate, PerformanceTelemetryContext } from '@floway-dev/provider';
import { mockPerfTelemetryContext, stubModelCandidate, stubProvider } from '@floway-dev/test-utils';

const stubCandidate = (id: string, upstream = 'up'): ModelCandidate =>
  stubModelCandidate({
    model: { id },
    provider: {
      upstream,
      kind: 'custom',
      name: upstream,
      disabledPublicModelIds: [],
      modelPrefix: null,
      instance: stubProvider(),
    },
  });

// iterateCandidates reads `attempt`, `apiKeyId`, and `runtimeLocation` from
// ctx — the last two feed `upstreamPerformanceContext` when stamping
// `attempt.telemetry`. Building through mockGatewayCtx keeps the stub aligned
// with the real GatewayCtx shape.
const stubCtx = (attempt: GatewayCtx['attempt']): GatewayCtx => mockGatewayCtx({ attempt });

describe('iterateCandidates', () => {
  it('clears the timing slots and stamps telemetry from the current candidate on entry', async () => {
    const attempt = { upstreamCallStartedAt: 999, firstOutputTokenAt: 999, telemetry: mockPerfTelemetryContext({ upstream: 'carryover' }) as PerformanceTelemetryContext | undefined };
    const ctx = stubCtx(attempt);
    const observed: Array<{ upstreamCallStartedAt: number | null; firstOutputTokenAt: number | null; upstream: string | undefined }> = [];

    await iterateCandidates(
      [stubCandidate('a', 'up_a'), stubCandidate('b', 'up_b'), stubCandidate('c', 'up_c')],
      'test',
      ctx,
      'chat',
      async candidate => {
        observed.push({
          upstreamCallStartedAt: attempt.upstreamCallStartedAt,
          firstOutputTokenAt: attempt.firstOutputTokenAt,
          upstream: attempt.telemetry?.upstream,
        });
        // Simulate an attempt that stamps timing then fails, so the loop
        // advances to the next candidate.
        attempt.upstreamCallStartedAt = 100;
        attempt.firstOutputTokenAt = 200;
        return candidate.model.id === 'c'
          ? { type: 'events' as const }
          : { type: 'api-error' as const };
      },
    );

    // Every attempt must observe cleared timing slots on entry — a prior
    // candidate's stamps (or the caller-supplied carryover) must not
    // survive into the next attempt. Telemetry must reflect the CURRENT
    // candidate: regressing this reintroduces the mid-attempt-throw
    // misattribution the stamp was hoisted to prevent.
    expect(observed).toEqual([
      { upstreamCallStartedAt: null, firstOutputTokenAt: null, upstream: 'up_a' },
      { upstreamCallStartedAt: null, firstOutputTokenAt: null, upstream: 'up_b' },
      { upstreamCallStartedAt: null, firstOutputTokenAt: null, upstream: 'up_c' },
    ]);
  });

  it('returns the first success and stops iterating', async () => {
    const ctx = stubCtx({ upstreamCallStartedAt: null, firstOutputTokenAt: null, telemetry: undefined });
    let calls = 0;
    const result = await iterateCandidates(
      [stubCandidate('a'), stubCandidate('b'), stubCandidate('c')],
      'test',
      ctx,
      'chat',
      async () => {
        calls++;
        return { type: 'events' as const };
      },
    );

    expect(result).toEqual({ type: 'events' });
    expect(calls).toBe(1);
  });

  it('returns the last failure once every candidate errors', async () => {
    const ctx = stubCtx({ upstreamCallStartedAt: null, firstOutputTokenAt: null, telemetry: undefined });
    let index = 0;
    const failures = [
      { type: 'api-error' as const, marker: 'first' },
      { type: 'internal-error' as const, marker: 'last' },
    ];
    const result = await iterateCandidates(
      [stubCandidate('a'), stubCandidate('b')],
      'test',
      ctx,
      'chat',
      async () => failures[index++]!,
    );

    expect(result).toEqual(failures[1]);
  });

  it('treats non-2xx plain results as failure so the next candidate runs', async () => {
    const ctx = stubCtx({ upstreamCallStartedAt: null, firstOutputTokenAt: null, telemetry: undefined });
    const attempts: number[] = [];
    const result = await iterateCandidates(
      [stubCandidate('a'), stubCandidate('b')],
      'test',
      ctx,
      'chat',
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
