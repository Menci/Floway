import { afterEach, expect, test } from 'vitest';

import type { ArchiveMetadata } from '../../../src/dump/archive-metadata.ts';
import { getDumpStore, initDumpStore } from '../../../src/dump/registry.ts';
import { tokenCountsFromUsage } from '../../../src/repo/usage-metrics.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, requestAppWithWarmModels, setupAppTest } from '../../test-utils/app.ts';
import { flushBackground } from '../../test-utils/background-tracker.ts';
import { decodeDump } from '@floway-dev/dump/browser';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const initialDumpStore = getDumpStore();
afterEach(() => { initDumpStore(initialDumpStore); });

const captureArchives = () => {
  const archives: { metadata: ArchiveMetadata; contents: string }[] = [];
  initDumpStore({
    ...initialDumpStore,
    archives: {
      async writeArchive(_keyId, _id, bytes) {
        const contents = await new Response(bytes).text();
        return async metadata => { archives.push({ metadata, contents }); };
      },
      async list() { return []; },
      async get() { return null; },
    },
  });
  return archives;
};

const saveCompletionsUpstream = (repo: Awaited<ReturnType<typeof setupAppTest>>['repo'], id: string, host: string, sortOrder: number) =>
  saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id,
    name: 'Completions Provider',
    sortOrder,
    config: {
      baseUrl: `https://${host}`,
      ingressHeadersRules: [],
      apiKey: 'sk-completions',
      endpoints: {},
      modelsFetch: { enabled: false, authStyle: 'bearer' },
      models: [{
        upstreamModelId: 'davinci-002',
        endpoints: { openaiCompletions: {} },
      }],
    },
  }));

const registerOpenAICompletionsUpstream = async (repo: Awaited<ReturnType<typeof setupAppTest>>['repo']): Promise<void> => {
  await repo.upstreams.deleteAll();
  await saveCompletionsUpstream(repo, 'up_completions', 'completions.example.com', 100);
};

const completionStream = (): Response => {
  const body = [
    'data: {"id":"cmpl_X","object":"text_completion","created":1,"model":"davinci-002","choices":[{"index":0,"text":"hello"}]}\n\n',
    'data: {"id":"cmpl_X","object":"text_completion","created":1,"model":"davinci-002","choices":[{"index":0,"text":" world","finish_reason":"stop"}]}\n\n',
    'data: {"id":"cmpl_X","object":"text_completion","created":1,"model":"davinci-002","choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
};

test('/v1/completions streaming forwards usage chunk when the client opted in', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerOpenAICompletionsUpstream(repo);

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'completions.example.com' && url.pathname === '/v1/completions') {
        return Promise.resolve(completionStream());
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({
          model: 'davinci-002',
          prompt: 'hello',
          stream: true,
          stream_options: { include_usage: true },
        }),
      });
      assertEquals(response.status, 200);
      const text = await response.text();
      assertEquals(text.includes('"usage"'), true);
      assertEquals(text.includes('"prompt_tokens":4'), true);
      assertEquals(text.includes('[DONE]'), true);
    },
  );
});

test.each(['read error', 'premature EOF', 'native error'] as const)('/v1/completions sends a data-only failure after partial output on %s', async mode => {
  const { apiKey, repo } = await setupAppTest();
  await registerOpenAICompletionsUpstream(repo);
  const partial = 'data: {"choices":[{"index":0,"text":"partial"}]}\n\n';
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  await withMockedFetch(
    () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        upstream = controller;
        controller.enqueue(new TextEncoder().encode(partial));
      },
    }), { headers: { 'content-type': 'text/event-stream' } }),
    async () => {
      const response = await requestAppWithWarmModels('/v1/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'davinci-002', prompt: 'hello', stream: true }),
      });
      assertEquals(response.status, 200);
      const reader = response.body!.getReader();
      const decode = new TextDecoder();
      assertEquals(decode.decode((await reader.read()).value), partial);
      const message = 'upstream completion read failed';
      const native = `data: ${JSON.stringify({ error: { code: 'vendor_failure', message } })}\n\n`;
      if (mode === 'read error') upstream.error(new Error(message));
      else if (mode === 'premature EOF') upstream.close();
      else upstream.enqueue(new TextEncoder().encode(native));
      const failure = decode.decode((await reader.read()).value);
      assertEquals(failure.startsWith('data: {"error":'), true);
      if (mode !== 'premature EOF') assertEquals(JSON.parse(failure.slice('data: '.length)).error.message, message);
      if (mode === 'native error') assertEquals(failure, native);
      assertEquals((await reader.read()).done, true);
    },
  );
  await flushBackground();
  const [performance] = await repo.performance.listAll();
  assertEquals(performance.errorsNoOutput, 1);
});

test('/v1/completions records JSON completion usage, neutral performance, and the rendered response in its archive', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  await registerOpenAICompletionsUpstream(repo);
  const archives = captureArchives();

  await withMockedFetch(
    () => Promise.resolve(jsonResponse({
      id: 'cmpl_x',
      object: 'text_completion',
      created: 1,
      model: 'davinci-002',
      choices: [{ index: 0, text: 'ok', finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
    })),
    async () => {
      const response = await requestAppWithWarmModels('/v1/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'davinci-002', prompt: 'hello' }),
      });
      assertEquals(response.status, 200);
      await response.json();
    },
  );

  await flushBackground();

  const usage = await repo.usage.listAll();
  assertEquals(usage.length, 1);
  assertEquals(usage[0]?.model, 'davinci-002');
  assertEquals(tokenCountsFromUsage(usage[0]!), { input: 7, output: 2 });

  const performance = await repo.performance.listAll();
  assertEquals(performance.length, 1);
  assertEquals(performance[0]?.model, 'davinci-002');
  assertEquals(performance[0]?.requests, 1);
  assertEquals(performance[0]?.errorsNoOutput, 0);

  expect(archives).toHaveLength(1);
  const { metadata, contents } = archives[0]!;
  expect(metadata).toMatchObject({ path: '/v1/completions', status: 200, model: 'davinci-002', inputTokens: 7, outputTokens: 2 });
  const dump = decodeDump(contents);
  expect(dump.stages.get(dump.rootStageIds[0]!)?.responseFacts).toMatchObject({
    'response.http': { status: 200, body: expect.any(Uint8Array) },
  });
});

test('/v1/completions archives and bills the usage frame even when the client omits it from delivery', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  await registerOpenAICompletionsUpstream(repo);
  const archives = captureArchives();

  await withMockedFetch(
    async request => {
      expect(await request.json()).toMatchObject({ stream: true, stream_options: { include_usage: true } });
      return completionStream();
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'davinci-002', prompt: 'hello', stream: true }),
      });
      assertEquals(response.status, 200);
      const text = await response.text();
      assertEquals(text.includes('"usage"'), false);
      assertEquals(text.includes('world'), true);
      assertEquals(text.includes('[DONE]'), true);
    },
  );

  await flushBackground();

  const usage = await repo.usage.listAll();
  assertEquals(usage.length, 1);
  assertEquals(tokenCountsFromUsage(usage[0]!), { input: 4, output: 2 });

  const performance = await repo.performance.listAll();
  assertEquals(performance.length, 1);
  assertEquals(performance[0]?.requests, 1);
  assertEquals(performance[0]?.errorsNoOutput, 0);

  expect(archives).toHaveLength(1);
  const { metadata, contents } = archives[0]!;
  expect(metadata).toMatchObject({ path: '/v1/completions', status: 200, model: 'davinci-002', inputTokens: 4, outputTokens: 2 });
  const frames = [...decodeDump(contents).streams.values()].flatMap(stream => stream.frames);
  expect(frames).toContainEqual({ ok: true, value: expect.objectContaining({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }) });
});

const completionResult = { id: 'cmpl_x', object: 'text_completion', created: 1, model: 'davinci-002', choices: [] };

test.each([
  {
    name: 'JSON error',
    second: () => jsonResponse({ error: { code: 'vendor_failure' } }, 400),
    status: 400,
    body: { error: { code: 'vendor_failure' } },
  },
  {
    name: 'text error',
    second: () => new Response('upstream unavailable', { status: 503 }),
    status: 503,
    body: { error: { message: 'upstream unavailable', type: 'api_error' } },
  },
  {
    name: 'completion',
    second: () => jsonResponse(completionResult),
    status: 200,
    body: completionResult,
  },
])('/completions meters failed candidates and renders the selected $name', async ({ second, status, body }) => {
  const { apiKey, repo } = await setupAppTest();
  await registerOpenAICompletionsUpstream(repo);
  await saveCompletionsUpstream(repo, 'second', 'second.example.com', 200);
  const calls: string[] = [];

  await withMockedFetch(async request => {
    const url = new URL(request.url);
    expect(await request.json()).toEqual({ model: 'davinci-002', prompt: 'hello' });
    calls.push(url.hostname);
    return url.hostname === 'completions.example.com' ? new Response('first failure', { status: 500 }) : second();
  }, async () => {
    const response = await requestAppWithWarmModels('/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
      body: JSON.stringify({ model: 'davinci-002', prompt: 'hello' }),
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
  });
  await flushBackground();

  expect(calls).toEqual(['completions.example.com', 'second.example.com']);
  expect(await repo.performance.listAll()).toEqual(expect.arrayContaining([
    expect.objectContaining({ upstream: 'up_completions', operation: 'text_completion', errorsNoOutput: 1, requests: 1 }),
    expect.objectContaining({ upstream: 'second', operation: 'text_completion', errorsNoOutput: status === 200 ? 0 : 1, requests: 1 }),
  ]));
  expect(await repo.usage.listAll()).toMatchObject(status === 200 ? [{ upstream: 'second', metrics: [], requests: 1 }] : []);
});
