import { expect, test, vi } from 'vitest';

import { servePipelineHttp } from '../../../src/data-plane/shared/pipeline-http.ts';
import type { HttpResponseFact } from '@floway-dev/http';
import { asEntry, factSpace, type Deferred, type Result } from '@floway-dev/pipeline';

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

test('delivers encoded bytes and relinquishes the whole response immediately', async () => {
  const { defineStage, compose } = factSpace<object, { http: HttpResponseFact; residual: Deferred<void> }>();
  const pending = Promise.withResolvers<void>();
  const signals: AbortSignal[] = [];
  const background: Promise<unknown>[] = [];
  const stage = defineStage({
    name: 'encode', request: { needs: [] }, return: { provides: ['http', 'residual'] },
    execute: async (_facts, scope) => {
      signals.push(scope.signal);
      return {
        http: {
          status: 429,
          statusText: 'Rate Limited',
          headers: [['set-cookie', 'a=1'], ['set-cookie', 'b=2']],
          body: bytes('rate limited'),
        },
        residual: scope.createDeferred(() => pending.promise),
      };
    },
  });
  const entry = asEntry(compose('encoded', { entry: [], exit: ['http', 'residual'], stages: [], ending: stage }));

  const response = await servePipelineHttp(entry, {}, {
    services: {}, signal: new AbortController().signal, waitUntil: work => { background.push(work); },
  });
  expect(response.status).toBe(429);
  expect(response.statusText).toBe('Rate Limited');
  expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
  expect(signals[0]?.aborted).toBe(true);
  expect(background).toHaveLength(1);
  await expect(response.text()).resolves.toBe('rate limited');
  pending.resolve();
  await Promise.all(background);
});

test.each(['done', 'cancel', 'panic'] as const)('settles encoded streaming delivery on %s', async mode => {
  const { defineStage, compose } = factSpace<object, { http: HttpResponseFact }>();
  const background: Promise<unknown>[] = [];
  const signals: AbortSignal[] = [];
  const finished: string[] = [];
  const failure = new Error('producer panic');
  const cancelReason = new Error('client disconnected');
  const stage = defineStage({
    name: 'encode-body', request: { needs: [] }, return: { provides: ['http'] },
    execute: async (_facts, scope) => {
      signals.push(scope.signal);
      const body = scope.createStream(async function* (): AsyncGenerator<Result<Uint8Array, never>> {
        try {
          yield { ok: true, value: bytes('chunk') };
          if (mode === 'panic') throw failure;
        } finally {
          finished.push('producer');
        }
      });
      return { http: { status: 200, statusText: 'OK', headers: [], body } };
    },
  });
  const entry = asEntry(compose('streaming', { entry: [], exit: ['http'], stages: [], ending: stage }));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await servePipelineHttp(entry, {}, {
      services: {}, signal: new AbortController().signal, waitUntil: work => { background.push(work); },
    });
    const reader = response.body!.getReader();
    await expect(reader.read()).resolves.toEqual({ done: false, value: bytes('chunk') });
    expect(signals[0]?.aborted).toBe(false);
    if (mode === 'cancel') {
      await reader.cancel(cancelReason);
      expect(signals[0]?.reason).toBe(cancelReason);
      expect(background).toHaveLength(1);
    } else if (mode === 'panic') {
      await expect(reader.read()).rejects.toBe(failure);
      expect(signals[0]?.reason).toBe(failure);
      expect(log.mock.calls[0]?.[1]).toBe(failure);
    } else {
      await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    }
    await Promise.all(background);
    expect(signals[0]?.aborted).toBe(true);
    expect(finished).toEqual(['producer']);
    if (mode !== 'panic') expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});
