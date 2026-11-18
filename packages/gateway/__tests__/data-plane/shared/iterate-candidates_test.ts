import { describe, expect, it, vi } from 'vitest';

import type { GatewayCtx } from '../../../src/data-plane/shared/gateway-ctx.ts';
import { iterateCandidates } from '../../../src/data-plane/shared/iterate-candidates.ts';
import { mockGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import type { ModelCandidate, PerformanceTelemetryContext } from '@floway-dev/provider';
import { mockPerfTelemetryContext, stubModelCandidate, stubProvider } from '@floway-dev/test-utils';

const stubCandidate = (id: string, upstream = 'up'): ModelCandidate =>
  stubModelCandidate({
    model: { id },
    provider: {
      upstreamId: upstream,
      kind: 'custom',
      name: upstream,
      inboundHeaderAllowlist: [],
      disabledPublicModelIds: [],
      modelPrefix: null,
      modelsCache: null,
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
    const attempt = { timing: { upstreamCallStartedAt: 999, firstOutputTokenAt: 999 }, telemetry: mockPerfTelemetryContext({ upstream: 'carryover' }) as PerformanceTelemetryContext | undefined };
    const ctx = stubCtx(attempt);
    const observed: Array<{ upstreamCallStartedAt: number | null; firstOutputTokenAt: number | null; upstream: string | undefined }> = [];

    await iterateCandidates(
      [stubCandidate('a', 'up_a'), stubCandidate('b', 'up_b'), stubCandidate('c', 'up_c')],
      'test',
      ctx,
      'chat',
      async candidate => {
        observed.push({
          upstreamCallStartedAt: attempt.timing.upstreamCallStartedAt,
          firstOutputTokenAt: attempt.timing.firstOutputTokenAt,
          upstream: attempt.telemetry?.upstream,
        });
        // Simulate an attempt that stamps timing then fails, so the loop
        // advances to the next candidate.
        attempt.timing.upstreamCallStartedAt = 100;
        attempt.timing.firstOutputTokenAt = 200;
        return candidate.model.id === 'c'
          ? { type: 'events' as const }
          : { type: 'api-error' as const, http: new Response(null, { status: 502 }) };
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
    const ctx = stubCtx({ timing: { upstreamCallStartedAt: null, firstOutputTokenAt: null }, telemetry: undefined });
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
    const ctx = stubCtx({ timing: { upstreamCallStartedAt: null, firstOutputTokenAt: null }, telemetry: undefined });
    let index = 0;
    const failures = [
      { type: 'api-error' as const, http: new Response(null, { status: 429 }), marker: 'first' },
      { type: 'internal-error' as const, http: new Response(null, { status: 502 }), marker: 'last' },
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

  it('starts the next attempt with the old body open and retains the selected failure untouched', async () => {
    const cancellation = Promise.withResolvers<void>();
    const tasks: Promise<unknown>[] = [];
    const ctx = mockGatewayCtx({ backgroundScheduler: promise => { tasks.push(promise); } });
    let cancelled = false;
    const first = new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
        return cancellation.promise;
      },
    }), { status: 503 });
    const last = new Response('last failure', {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'retry-after': '12' },
    });

    try {
      const result = await iterateCandidates(
        [stubCandidate('a'), stubCandidate('b')],
        'test',
        ctx,
        'rerank',
        async candidate => {
          if (candidate.model.id === 'a') return { type: 'response' as const, http: first };
          expect(first.bodyUsed).toBe(false);
          expect(cancelled).toBe(false);
          return { type: 'response' as const, http: last };
        },
      );

      expect(cancelled).toBe(true);
      expect(tasks).toHaveLength(1);
      expect(result.http).toBe(last);
      expect(last.bodyUsed).toBe(false);
      expect(result.http.statusText).toBe('Too Many Requests');
      expect(result.http.headers.get('retry-after')).toBe('12');
      expect(await result.http.text()).toBe('last failure');
    } finally {
      cancellation.resolve();
      await Promise.all(tasks);
    }
  });

  it.each(['success', 'throw'])('cancels the retained failure when the next attempt ends with %s', async outcome => {
    let cancelled = false;
    const first = new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    }), { status: 429 });
    const success = new Response('ok');
    const originalError = new Error('next attempt threw');
    const selection = iterateCandidates(
      [stubCandidate('a'), stubCandidate('b')],
      'test',
      mockGatewayCtx(),
      'decision',
      async candidate => {
        if (candidate.model.id === 'a') return { type: 'response' as const, http: first };
        if (outcome === 'throw') throw originalError;
        return { type: 'response' as const, http: success };
      },
    );

    if (outcome === 'throw') await expect(selection).rejects.toBe(originalError);
    else expect((await selection).http).toBe(success);
    expect(cancelled).toBe(true);
    expect(success.bodyUsed).toBe(false);
  });

  it('keeps a successful candidate when cancellation of an errored body rejects', async () => {
    const bodyError = new Error('upstream body broke');
    const first = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(bodyError); },
    }), { status: 429 });
    const success = new Response('ok');
    const tasks: Promise<unknown>[] = [];
    const ctx = mockGatewayCtx({ backgroundScheduler: promise => { tasks.push(promise); } });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const result = await iterateCandidates(
        [stubCandidate('a'), stubCandidate('b')],
        'test',
        ctx,
        'rerank',
        async candidate => ({ type: 'response' as const, http: candidate.model.id === 'a' ? first : success }),
      );

      expect(result.http).toBe(success);
      expect(tasks).toHaveLength(1);
      await Promise.all(tasks);
      expect(warning).toHaveBeenCalledWith('Floway: failed to cancel a discarded upstream response', bodyError);
    } finally {
      warning.mockRestore();
    }
  });

  it('treats non-2xx plain results as failure so the next candidate runs', async () => {
    const ctx = stubCtx({ timing: { upstreamCallStartedAt: null, firstOutputTokenAt: null }, telemetry: undefined });
    const attempts: number[] = [];
    const result = await iterateCandidates(
      [stubCandidate('a'), stubCandidate('b')],
      'test',
      ctx,
      'chat',
      async candidate => {
        attempts.push(attempts.length);
        return candidate.model.id === 'a'
          ? { type: 'plain' as const, http: { status: 500, headers: new Headers() } }
          : { type: 'plain' as const, http: { status: 200, headers: new Headers() } };
      },
    );

    expect(attempts).toEqual([0, 1]);
    expect(result).toEqual({ type: 'plain', http: { status: 200, headers: new Headers() } });
  });
});
