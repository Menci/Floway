import { test } from 'vitest';

import { initDumpBroker, initDumpStore } from '../../../src/dump/registry.ts';
import { tokenCountsFromUsage } from '../../../src/repo/usage-metrics.ts';
import { installDumpStubs } from '../../dump/test-fixtures.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, flushAsyncWork, requestAppWithWarmModels, setupAppTest } from '../../test-utils/app.ts';
import { UpstreamTransportError } from '@floway-dev/http';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

// A custom upstream is the easiest fixture to assert /completions against:
// the operator declares the endpoint capability per-model, and the path
// resolves to /v1/completions through the default pathOverrides table.
const registerOpenAICompletionsUpstream = async (repo: Awaited<ReturnType<typeof setupAppTest>>['repo']): Promise<void> => {
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_completions',
    name: 'Passthrough Completions Provider',
    sortOrder: 100,
    config: {
      baseUrl: 'https://passthrough.example.com',
      ingressHeadersRules: [],
      apiKey: 'sk-passthrough',
      endpoints: {},
      modelsFetch: { enabled: false, authStyle: 'bearer' },
      models: [{
        upstreamModelId: 'davinci-002',
        endpoints: { openaiCompletions: {} },
      }],
    },
  }));
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

test.each([
  { body: { prompt: 'hello' }, status: 400, model: null },
  { body: { model: 'missing-completions-model', prompt: 'hello' }, status: 404, model: 'missing-completions-model' },
])('/v1/completions archives local rejection with status $status and model $model', async ({ body, status, model }) => {
  const { apiKey, repo } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  await registerOpenAICompletionsUpstream(repo);
  const dumpStubs = installDumpStubs(initDumpStore, initDumpBroker);

  await withMockedFetch(
    request => { throw new Error(`Unexpected upstream request ${request.url}`); },
    async () => {
      const response = await requestAppWithWarmModels('/v1/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify(body),
      });
      assertEquals(response.status, status);
      await response.json();
    },
  );
  await flushAsyncWork();

  assertEquals(dumpStubs.published.length, 1);
  const { meta } = dumpStubs.published[0]!;
  assertEquals(meta.error, { kind: 'gateway' });
  assertEquals(meta.model, model);
  assertEquals(meta.upstream, null);
});

test('/v1/completions streaming forwards usage chunk when the client opted in', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerOpenAICompletionsUpstream(repo);

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'passthrough.example.com' && url.pathname === '/v1/completions') {
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
      if (mode === 'read error') upstream.error(new UpstreamTransportError(new Error(message)));
      else if (mode === 'premature EOF') upstream.close();
      else upstream.enqueue(new TextEncoder().encode(native));
      const failure = decode.decode((await reader.read()).value);
      assertEquals(failure.startsWith('data: {"error":'), true);
      if (mode !== 'premature EOF') assertEquals(JSON.parse(failure.slice('data: '.length)).error.message, message);
      if (mode === 'native error') assertEquals(failure, native);
      assertEquals((await reader.read()).done, true);
    },
  );
  await flushAsyncWork();
  const [performance] = await repo.performance.listAll();
  assertEquals(performance.errorsNoOutput, 1);
});

test('/v1/completions non-streaming records usage, performance, and a pipeline archive', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  await registerOpenAICompletionsUpstream(repo);
  const dumpStubs = installDumpStubs(initDumpStore, initDumpBroker);

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

  await flushAsyncWork();

  const usage = await repo.usage.listAll();
  assertEquals(usage.length, 1);
  assertEquals(usage[0]?.model, 'davinci-002');
  assertEquals(tokenCountsFromUsage(usage[0]!), { input: 7, output: 2 });

  const performance = await repo.performance.listAll();
  assertEquals(performance.length, 1);
  assertEquals(performance[0]?.model, 'davinci-002');
  assertEquals(performance[0]?.requests, 1);
  assertEquals(performance[0]?.errorsNoOutput, 0);

  assertEquals(dumpStubs.published.length, 1);
  const { meta } = dumpStubs.published[0]!;
  assertEquals(meta.path, '/v1/completions');
  assertEquals(meta.status, 200);
  assertEquals(meta.model, 'davinci-002');
  assertEquals(meta.inputTokens, 7);
  assertEquals(meta.outputTokens, 2);
  const archive = await dumpStubs.store.getArchive(apiKey.id, meta.id);
  const ndjson = await new Response(archive).text();
  assertEquals(ndjson.includes('openaiCompletions.compute-usage'), true);
});

test('/v1/completions streaming omits unrequested usage from SSE and records it in the pipeline archive', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  await registerOpenAICompletionsUpstream(repo);
  const dumpStubs = installDumpStubs(initDumpStore, initDumpBroker);

  await withMockedFetch(
    async request => {
      const body = await request.json() as { stream_options: unknown };
      assertEquals(body.stream_options, { include_usage: true, vendor_option: 'preserved' });
      return completionStream();
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'davinci-002', prompt: 'hello', stream: true, stream_options: { include_usage: false, vendor_option: 'preserved' } }),
      });
      assertEquals(response.status, 200);
      const text = await response.text();
      assertEquals(text.includes('"usage"'), false);
      assertEquals(text.includes('world'), true);
      assertEquals(text.includes('[DONE]'), true);
    },
  );

  await flushAsyncWork();

  const usage = await repo.usage.listAll();
  assertEquals(usage.length, 1);
  assertEquals(tokenCountsFromUsage(usage[0]!), { input: 4, output: 2 });

  const performance = await repo.performance.listAll();
  assertEquals(performance.length, 1);
  assertEquals(performance[0]?.requests, 1);
  assertEquals(performance[0]?.errorsNoOutput, 0);

  assertEquals(dumpStubs.published.length, 1);
  const { meta } = dumpStubs.published[0]!;
  assertEquals(meta.path, '/v1/completions');
  assertEquals(meta.status, 200);
  assertEquals(meta.model, 'davinci-002');
  assertEquals(meta.inputTokens, 4);
  assertEquals(meta.outputTokens, 2);
  const archive = await dumpStubs.store.getArchive(apiKey.id, meta.id);
  const ndjson = await new Response(archive).text();
  assertEquals(ndjson.includes('"stream.frame"'), true);
  assertEquals(ndjson.includes('"prompt_tokens":4'), true);
});
