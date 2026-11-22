import { test } from 'vitest';

import { initDumpBroker, initDumpStore } from '../../../src/dump/registry.ts';
import { tokenCountsFromUsage } from '../../../src/repo/usage-metrics.ts';
import { installDumpStubs } from '../../dump/test-fixtures.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, flushAsyncWork, requestAppWithWarmModels, setupAppTest } from '../../test-utils/app.ts';
import { flushBackground } from '../../test-utils/background-tracker.ts';
import { clearInProcessCopilotTokenCache } from '@floway-dev/provider-copilot';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

// A custom upstream is the easiest fixture to assert /completions against:
// the operator declares the endpoint capability per-model, and the path
// resolves to /v1/completions through the default pathOverrides table.
const registerOpenAICompletionsUpstream = async (repo: Awaited<ReturnType<typeof setupAppTest>>['repo']): Promise<void> => {
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();
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

// Dual-path coverage: usage + performance + dump telemetry must land
// equivalently on both the non-streaming JSON and the streaming SSE
// branches. The handler does not force `stream: true` upstream the way
// openai-chat-completions does (no chat protocol frame normalization), so the two
// paths really do exercise different scaffold branches and the assertions
// here keep them honest.
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
  await flushAsyncWork();
  await flushBackground();
  const [performance] = await repo.performance.listAll();
  assertEquals(performance.errorsNoOutput, 1);
});

test('/v1/completions non-streaming records usage row, performance neutral row (text_completion operation, no TTFT/TPOT), and a bytes-body dump record', async () => {
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

  assertEquals(dumpStubs.stored.length, 1);
  const dump = dumpStubs.stored[0]!;
  assertEquals(dump.meta.path, '/v1/completions');
  assertEquals(dump.meta.status, 200);
  assertEquals(dump.meta.model, 'davinci-002');
  assertEquals(dump.meta.inputTokens, 7);
  assertEquals(dump.meta.outputTokens, 2);
  assertEquals(dump.artifact.byteLength > 0, true);
});

test('/v1/completions streaming strips the unrequested usage chunk yet records usage and a frame-log dump', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  await registerOpenAICompletionsUpstream(repo);
  const dumpStubs = installDumpStubs(initDumpStore, initDumpBroker);

  await withMockedFetch(
    () => Promise.resolve(completionStream()),
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

  await flushAsyncWork();
  await flushBackground();

  const usage = await repo.usage.listAll();
  assertEquals(usage.length, 1);
  assertEquals(tokenCountsFromUsage(usage[0]!), { input: 4, output: 2 });

  const performance = await repo.performance.listAll();
  assertEquals(performance.length, 1);
  assertEquals(performance[0]?.requests, 1);
  assertEquals(performance[0]?.errorsNoOutput, 0);

  assertEquals(dumpStubs.stored.length, 1);
  const dump = dumpStubs.stored[0]!;
  assertEquals(dump.meta.path, '/v1/completions');
  assertEquals(dump.meta.status, 200);
  assertEquals(dump.meta.model, 'davinci-002');
  assertEquals(dump.meta.inputTokens, 4);
  assertEquals(dump.meta.outputTokens, 2);
  const artifact = new TextDecoder().decode(dump.artifact);
  assertEquals(artifact.includes('"usage"'), true);
  assertEquals(artifact.includes('"prompt_tokens":4'), true);
});
