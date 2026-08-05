import { expect, test, vi } from 'vitest';

import { tokenUsageFromEmbeddingsBody } from '../../../src/data-plane/embeddings/usage.ts';
import { observeJsonResponse } from '../../../src/data-plane/shared/json-response.ts';
import { initRepo } from '../../../src/repo/index.ts';
import { tokenCountsFromUsage } from '../../../src/repo/usage-metrics.ts';
import { InMemoryRepo } from '../../repo/memory.ts';
import { mockGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import { mockPerfTelemetryContext, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const encoder = new TextEncoder();

const harness = () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const background: Promise<unknown>[] = [];
  const ctx = mockGatewayCtx({
    apiKeyId: 'key_json_observer',
    backgroundScheduler: promise => { background.push(promise); },
  });
  const performance = mockPerfTelemetryContext({
    keyId: ctx.apiKeyId,
    model: 'embedding-model',
    upstream: 'up_json',
    operation: 'embeddings',
  });
  const flush = async () => {
    for (const promise of background) await promise;
  };
  const observe = (response: Response): Response => observeJsonResponse({
    ctx,
    response,
    performance,
    identity: { ...testTelemetryModelIdentity, model: 'embedding-model', upstream: 'up_json', modelKey: 'embedding-model' },
    sourceApi: '/embeddings',
    extractBilling: tokenUsageFromEmbeddingsBody,
  });
  return { repo, observe, flush };
};

test('observeJsonResponse forwards bytes before EOF and settles usage only after completion', async () => {
  const { repo, observe, flush } = harness();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let pulled = false;
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('{"data":['));
    },
    async pull(controller) {
      if (pulled) return;
      pulled = true;
      await gate;
      controller.enqueue(encoder.encode('],"usage":{"prompt_tokens":3,"total_tokens":3}}'));
      controller.close();
    },
  }, { highWaterMark: 0 });

  const response = observe(new Response(upstream, { headers: { 'content-type': 'application/json' } }));
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toBe('{"data":[');
  expect(await repo.usage.listAll()).toEqual([]);

  release();
  while (!(await reader.read()).done) { /* drain */ }
  await flush();

  const rows = await repo.usage.listAll();
  expect(rows).toHaveLength(1);
  expect(tokenCountsFromUsage(rows[0])).toEqual({ input: 3 });
});

test('observeJsonResponse skips a large unobserved field and recognizes escaped keys across chunks', async () => {
  const { repo, observe, flush } = harness();
  const json = JSON.stringify({
    data: ['x'.repeat(70_000)],
    usage: { prompt_tokens: 7, total_tokens: 7 },
    service_tier: 'priority',
  }).replace('"usage"', '"u\\u0073age"');
  const escapedKey = json.indexOf('"u\\u0073age"');
  const chunks = [
    encoder.encode(json.slice(0, escapedKey + 3)),
    encoder.encode(json.slice(escapedKey + 3, escapedKey + 7)),
    encoder.encode(json.slice(escapedKey + 7)),
  ];
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

  const response = observe(new Response(upstream, { headers: { 'content-type': 'application/json' } }));
  expect((await response.text()).length).toBe(json.length);
  await flush();

  const rows = await repo.usage.listAll();
  expect(tokenCountsFromUsage(rows[0])).toEqual({ input: 7 });
});

test('observeJsonResponse forwards malformed or oversized observed data as request-only usage', async () => {
  for (const body of [
    '{"data":[],"usage":{"prompt_tokens":1,"total_tokens":1}',
    JSON.stringify({ usage: { prompt_tokens: 1, total_tokens: 1, padding: 'x'.repeat(66_000) } }),
  ]) {
    const { repo, observe, flush } = harness();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const response = observe(new Response(body, { headers: { 'content-type': 'application/json' } }));
      expect(await response.text()).toBe(body);
      await flush();
      const rows = await repo.usage.listAll();
      expect(rows).toHaveLength(1);
      expect(tokenCountsFromUsage(rows[0])).toEqual({});
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
    }
  }
});

test('observeJsonResponse cancels the upstream and settles a failed request exactly once', async () => {
  const { repo, observe, flush } = harness();
  let canceled = 0;
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('{"data":['));
    },
    cancel() {
      canceled += 1;
    },
  });
  const response = observe(new Response(upstream, { headers: { 'content-type': 'application/json' } }));
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel('client left');
  await flush();

  expect(canceled).toBe(1);
  const usage = await repo.usage.listAll();
  expect(usage).toHaveLength(1);
  expect(tokenCountsFromUsage(usage[0])).toEqual({});
  const performance = await repo.performance.listAll();
  expect(performance).toHaveLength(1);
  expect(performance[0].errorsNoOutput).toBe(1);
});

test('observeJsonResponse exposes upstream read failure and settles once', async () => {
  const { repo, observe, flush } = harness();
  let pulls = 0;
  const failure = new Error('upstream body failed');
  const upstream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) controller.enqueue(encoder.encode('{"data":[]'));
      else controller.error(failure);
    },
  }, { highWaterMark: 0 });
  const response = observe(new Response(upstream, { headers: { 'content-type': 'application/json' } }));

  await expect(response.text()).rejects.toBe(failure);
  await flush();
  expect(await repo.usage.listAll()).toHaveLength(1);
  expect(await repo.performance.listAll()).toHaveLength(1);
});
