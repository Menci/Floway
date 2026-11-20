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
      modelsCache: null, pipelines: {},
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

  it.each([
    ['60', undefined, 'first'],
    ['120', '60', 'last'],
    ['soon', '60', 'last'],
    ['0.5', '1', 'first'],
    ['Mon, 01 Jun 2026 00:00:30 GMT', '60', 'first'],
    ['Monday, 01-Jun-26 00:00:30 GMT', '60', 'first'],
    ['Sun, 31 May 2026 23:59:00 GMT', '60', 'first'],
  ])('selects the original earliest retry response (%s, %s)', async (first, last, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
    const failures = [first, last].map((retryAfter, index) => ({
      type: 'api-error' as const,
      http: {
        status: index === 0 ? 429 : 503,
        headers: new Headers(retryAfter === undefined ? {} : { 'retry-after': retryAfter }),
      },
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

  it('compares legacy asctime dates in UTC when the runtime time zone differs', async () => {
    vi.stubEnv('TZ', 'Asia/Singapore');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));

    try {
      expect(new Date().getTimezoneOffset()).toBe(-480);
      const first = {
        type: 'response' as const,
        http: new Response(null, { status: 429, headers: { 'retry-after': 'Mon Jun  1 00:00:30 2026' } }),
      };
      const last = {
        type: 'response' as const,
        http: new Response(null, { status: 429, headers: { 'retry-after': '17' } }),
      };
      const result = await iterateCandidates(
        [stubCandidate('a'), stubCandidate('b')], 'test', mockGatewayCtx(), 'chat',
        async candidate => candidate.model.id === 'a' ? first : last,
      );

      expect(result).toBe(last);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('compares retry delays from when each response arrived', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
    const failures = [60, 55].map(seconds => ({ type: 'api-error' as const, http: { status: 429, headers: new Headers({ 'retry-after': String(seconds) }) } }));
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

  it.each([false, true])('cancels the discarded raw response and preserves the winner (success=%s)', async succeeds => {
    let countCancelled = 0;
    const failure = {
      type: 'response' as const,
      http: new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('limited')); },
        cancel() { countCancelled++; },
      }), { status: 429, headers: { 'retry-after': '60' } }),
    };
    let otherCancelled = 0;
    const terminal = {
      type: 'response' as const,
      http: succeeds ? new Response('ok') : new Response(new ReadableStream<Uint8Array>({
        cancel() { otherCancelled++; },
      }), { status: 503 }),
    };

    const result = await iterateCandidates(
      [stubCandidate('a'), stubCandidate('b')], 'test', mockGatewayCtx(), 'chat',
      async candidate => candidate.model.id === 'a' ? failure : terminal,
    );

    expect(result).toBe(succeeds ? terminal : failure);
    expect(result.http.bodyUsed).toBe(false);
    expect(countCancelled).toBe(succeeds ? 1 : 0);
    expect(otherCancelled).toBe(succeeds ? 0 : 1);
    await result.http.body?.cancel();
  });

  it('advances after a dial failure and preserves a retry response if the last dial fails', async () => {
    const dialError = new ProxyDialError('connection refused', 'tcp-connect');
    const failure = { type: 'api-error' as const, http: { status: 429, headers: new Headers({ 'retry-after': '60' }) } };
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
        if (candidate.model.id === 'a') return { type: 'api-error' as const, http: { status: 503, headers: new Headers() } };
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
        return { type: 'api-error' as const, http: { status: 429, headers: new Headers({ 'retry-after': '60' }) } };
      },
    )).rejects.toBe(reason);
    expect(calls).toEqual(['a']);
  });
});
