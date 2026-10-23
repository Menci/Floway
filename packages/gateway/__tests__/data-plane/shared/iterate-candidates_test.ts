import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GatewayCtx } from '../../../src/data-plane/shared/gateway-ctx.ts';
import { iterateCandidates } from '../../../src/data-plane/shared/iterate-candidates.ts';
import { mockGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import type { ModelCandidate, PerformanceTelemetryContext } from '@floway-dev/provider';
import { ProxyDialError } from '@floway-dev/proxy';
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
  afterEach(() => vi.useRealTimers());

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
          ? { type: 'plain' as const, status: 500 }
          : { type: 'plain' as const, status: 200 };
      },
    );

    expect(attempts).toEqual([0, 1]);
    expect(result).toEqual({ type: 'plain', status: 200 });
  });

  it.each([
    ['60', undefined, 'first'],
    ['60', '120', 'first'],
    ['120', '60', 'last'],
    ['soon', '60', 'last'],
    ['60', '-1', 'first'],
    ['60', '1.2.3', 'first'],
    ['0', '60', 'first'],
    ['Mon, 01 Jun 2026 00:00:30 GMT', '60', 'first'],
    ['120', 'Mon, 01 Jun 2026 00:00:30 GMT', 'last'],
    ['Sun, 31 May 2026 23:59:00 GMT', '60', 'first'],
  ])('selects the original earliest retry response (%s, %s)', async (first, last, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
    const failures = [first, last].map((retryAfter, index) => ({
      type: 'api-error' as const,
      status: index === 0 ? 429 : 503,
      headers: new Headers(retryAfter === undefined ? {} : { 'retry-after': retryAfter }),
      marker: index === 0 ? 'first' : 'last',
    }));
    let index = 0;
    const result = await iterateCandidates(
      [stubCandidate('a'), stubCandidate('b')], 'test', mockGatewayCtx(), 'chat',
      async () => failures[index++]!,
    );
    expect(index).toBe(2);
    expect(result).toBe(failures[expected === 'first' ? 0 : 1]);
  });

  it('compares retry delays from when each response arrived', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
    const failures = [60, 55].map(seconds => ({ type: 'api-error' as const, headers: new Headers({ 'retry-after': String(seconds) }) }));
    let index = 0;
    const result = await iterateCandidates(
      [stubCandidate('a'), stubCandidate('b')], 'test', mockGatewayCtx(), 'chat',
      async () => {
        if (index === 1) vi.advanceTimersByTime(10_000);
        return failures[index++]!;
      },
    );
    expect(result).toBe(failures[0]);
  });

  it('uses retry hints on passthrough responses and still lets success win', async () => {
    const failure = { type: 'plain' as const, status: 429, response: new Response('limited', { status: 429, headers: { 'retry-after': '60' } }) };
    const last = { type: 'plain' as const, status: 503, response: new Response('unavailable', { status: 503 }) };
    for (const terminal of [last, { type: 'plain' as const, status: 200, response: new Response('ok') }]) {
      let index = 0;
      const result = await iterateCandidates(
        [stubCandidate('a'), stubCandidate('b')], 'test', mockGatewayCtx(), 'chat',
        async () => [failure, terminal][index++]!,
      );
      expect(result).toBe(terminal.status === 200 ? terminal : failure);
    }
  });

  it('advances after a dial failure and preserves a retry response if the last dial fails', async () => {
    const dialError = new ProxyDialError('connection refused', 'tcp-connect');
    const failure = { type: 'api-error' as const, headers: new Headers({ 'retry-after': '60' }) };
    const calls: string[] = [];
    const result = await iterateCandidates(
      [stubCandidate('a'), stubCandidate('b'), stubCandidate('c')], 'test', mockGatewayCtx(), 'chat',
      async candidate => {
        calls.push(candidate.model.id);
        if (candidate.model.id !== 'b') throw dialError;
        return failure;
      },
    );
    expect(calls).toEqual(['a', 'b', 'c']);
    expect(result).toBe(failure);
  });

  it('rethrows the terminal transport error with its cause when no response offers a retry time', async () => {
    const cause = new Error('socket refused');
    const terminal = new ProxyDialError('connection refused', 'tcp-connect', { cause });
    const ctx = mockGatewayCtx();
    const calls: string[] = [];
    await expect(iterateCandidates(
      [stubCandidate('a'), stubCandidate('b')], 'test', ctx, 'chat',
      async candidate => {
        calls.push(candidate.model.id);
        if (candidate.model.id === 'a') return { type: 'api-error' as const };
        throw terminal;
      },
    )).rejects.toBe(terminal);
    expect(calls).toEqual(['a', 'b']);
    expect(ctx.attempt.telemetry?.model).toBe('b');
    expect(terminal.cause).toBe(cause);
  });

  it.each([new Error('interceptor bug'), new DOMException('cancelled', 'AbortError'), new ProxyDialError('bad proxy', 'config')])('never hides a non-retryable failure (%s)', async error => {
    const calls: string[] = [];
    await expect(iterateCandidates(
      [stubCandidate('a'), stubCandidate('b')], 'test', mockGatewayCtx(), 'chat',
      async candidate => {
        calls.push(candidate.model.id);
        throw error;
      },
    )).rejects.toBe(error);
    expect(calls).toEqual(['a']);
  });

  it('stops when the client cancels between upstream attempts', async () => {
    const controller = new AbortController();
    const reason = new Error('client stopped');
    const calls: string[] = [];
    await expect(iterateCandidates(
      [stubCandidate('a'), stubCandidate('b')], 'test', mockGatewayCtx({ abortSignal: controller.signal }), 'chat',
      async candidate => {
        calls.push(candidate.model.id);
        controller.abort(reason);
        return { type: 'api-error' as const, headers: new Headers({ 'retry-after': '60' }) };
      },
    )).rejects.toBe(reason);
    expect(calls).toEqual(['a']);
  });
});
