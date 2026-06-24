import { test } from 'vitest';

import { initDumpBroker, initDumpStore } from '../../dump/registry.ts';
import { installDumpStubs } from '../../dump/test-fixtures.ts';
import { buildCustomUpstreamRecord, flushAsyncWork, requestApp, setupAppTest } from '../../test-helpers.ts';
import { clearInProcessCopilotTokenCache } from '@floway-dev/provider-copilot';
import { assertEquals, assertExists, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

// A custom upstream is the easiest fixture to assert /completions against:
// the operator declares the endpoint capability per-model, and the path
// resolves to /v1/completions through the default pathOverrides table.
const registerCompletionsUpstream = async (repo: Awaited<ReturnType<typeof setupAppTest>>['repo']): Promise<void> => {
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_completions',
    name: 'Passthrough Completions Provider',
    sortOrder: 100,
    config: {
      baseUrl: 'https://passthrough.example.com',
      authStyle: 'bearer',
      apiKey: 'sk-passthrough',
      endpoints: {},
      modelsFetch: { enabled: false },
      models: [{
        upstreamModelId: 'davinci-002',
        endpoints: { completions: {} },
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

test('/v1/completions non-streaming forwards body to upstream /v1/completions and records usage', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerCompletionsUpstream(repo);
  let forwardedBody: Record<string, unknown> | undefined;
  let forwardedUrl: string | undefined;
  let responseBody: unknown;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'passthrough.example.com' && url.pathname === '/v1/completions') {
        forwardedBody = (await request.json()) as Record<string, unknown>;
        forwardedUrl = url.href;
        return jsonResponse({
          id: 'cmpl_resp',
          object: 'text_completion',
          created: 1,
          model: 'davinci-002',
          choices: [{ index: 0, text: ' world', finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'davinci-002', prompt: 'hello' }),
      });
      responseBody = await response.json();
      assertEquals(response.status, 200, `got ${response.status}: ${JSON.stringify(responseBody)}`);
    },
  );

  assertExists(forwardedBody);
  assertEquals(forwardedUrl, 'https://passthrough.example.com/v1/completions');
  assertEquals(forwardedBody.model, 'davinci-002');
  assertEquals(forwardedBody.prompt, 'hello');
  assertEquals(forwardedBody.stream, undefined);
  assertEquals((responseBody as { usage: { prompt_tokens: number } }).usage.prompt_tokens, 5);

  await flushAsyncWork();
  const usageRows = await repo.usage.listAll();
  assertEquals(usageRows.length, 1);
  assertEquals(usageRows[0]?.tokens.input, 5);
  assertEquals(usageRows[0]?.tokens.output, 1);
});

test('/v1/completions streaming forces stream_options.include_usage upstream', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerCompletionsUpstream(repo);
  let forwardedBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'passthrough.example.com' && url.pathname === '/v1/completions') {
        forwardedBody = (await request.json()) as Record<string, unknown>;
        return completionStream();
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'davinci-002', prompt: 'hello', stream: true }),
      });
      assertEquals(response.status, 200);
      await response.text();
    },
  );

  assertExists(forwardedBody);
  assertEquals(forwardedBody.stream, true);
  assertEquals((forwardedBody.stream_options as { include_usage?: boolean } | undefined)?.include_usage, true);
});

test('/v1/completions streaming strips usage chunk when client did not request include_usage', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerCompletionsUpstream(repo);

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'passthrough.example.com' && url.pathname === '/v1/completions') {
        return Promise.resolve(completionStream());
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'davinci-002', prompt: 'hello', stream: true }),
      });
      assertEquals(response.status, 200);
      const text = await response.text();
      // No usage chunk reaches the client.
      assertEquals(text.includes('"usage"'), false);
      assertEquals(text.includes('[DONE]'), true);
      // Content frames still flow through.
      assertEquals(text.includes('hello'), true);
      assertEquals(text.includes('world'), true);
    },
  );

  await flushAsyncWork();
  const usageRows = await repo.usage.listAll();
  assertEquals(usageRows.length, 1);
  assertEquals(usageRows[0]?.tokens.input, 4);
  assertEquals(usageRows[0]?.tokens.output, 2);
});

test('/v1/completions streaming forwards usage chunk when the client opted in', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerCompletionsUpstream(repo);

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'passthrough.example.com' && url.pathname === '/v1/completions') {
        return Promise.resolve(completionStream());
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/completions', {
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

test('/v1/completions rejects malformed body with the standard 400', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp('/v1/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: '{not json',
  });
  assertEquals(response.status, 400);
  const body = await response.json() as { error: { message: string; type: string } };
  assertEquals(body.error.type, 'api_error');
  assertEquals(body.error.message.includes('valid JSON'), true);
});

test('/v1/completions rejects a model without the completions endpoint with the standard 400', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();
  // A custom upstream that only exposes chatCompletions on the model.
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_chat_only',
    config: {
      baseUrl: 'https://passthrough.example.com',
      authStyle: 'bearer',
      apiKey: 'sk-x',
      endpoints: {},
      modelsFetch: { enabled: false },
      models: [{
        upstreamModelId: 'davinci-002',
        endpoints: { chatCompletions: {} },
      }],
    },
  }));

  const response = await requestApp('/v1/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ model: 'davinci-002', prompt: 'hello' }),
  });
  assertEquals(response.status, 400);
  const body = await response.json() as { error: { message: string } };
  assertEquals(body.error.message, 'Model davinci-002 does not support the /completions endpoint.');
});

test('/v1/completions handler also serves the unversioned /completions path', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerCompletionsUpstream(repo);

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'passthrough.example.com' && url.pathname === '/v1/completions') {
        return Promise.resolve(jsonResponse({
          id: 'cmpl_a',
          object: 'text_completion',
          created: 1,
          model: 'davinci-002',
          choices: [{ index: 0, text: 'x', finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'davinci-002', prompt: 'x' }),
      });
      assertEquals(response.status, 200);
      await response.json();
    },
  );
});

// Dual-path coverage: usage + performance + dump telemetry must land
// equivalently on both the non-streaming JSON and the streaming SSE
// branches. The handler does not force `stream: true` upstream the way
// chat-completions does (no interceptor framework to feed), so the two
// paths really do exercise different scaffold branches and the assertions
// here keep them honest.
test('/v1/completions non-streaming records usage row, request_total+upstream_success performance rows, and a bytes-body dump record', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  await registerCompletionsUpstream(repo);
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
      const response = await requestApp('/v1/completions', {
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
  assertEquals(usage[0]?.tokens.input, 7);
  assertEquals(usage[0]?.tokens.output, 2);

  const performance = await repo.performance.listAll();
  const requestTotal = performance.find(row => row.metricScope === 'request_total');
  const upstreamSuccess = performance.find(row => row.metricScope === 'upstream_success');
  assertExists(requestTotal);
  assertExists(upstreamSuccess);
  assertEquals(requestTotal.model, 'davinci-002');
  assertEquals(requestTotal.stream, false);
  assertEquals(requestTotal.requests, 1);
  assertEquals(requestTotal.errors, 0);
  assertEquals(upstreamSuccess.stream, false);
  assertEquals(upstreamSuccess.requests, 1);
  assertEquals(upstreamSuccess.errors, 0);

  assertEquals(dumpStubs.stored.length, 1);
  const dump = dumpStubs.stored[0]!.record;
  assertEquals(dump.meta.path, '/v1/completions');
  assertEquals(dump.meta.status, 200);
  assertEquals(dump.meta.model, 'davinci-002');
  assertEquals(dump.meta.inputTokens, 7);
  assertEquals(dump.meta.outputTokens, 2);
  // Non-streaming: the upstream sent a one-shot JSON, so the dump
  // captures the bytes (not a frame log).
  assertEquals(dump.response.body.type, 'bytes');
});

test('/v1/completions streaming records usage row, request_total+upstream_success performance rows with stream=true, and a frame-log dump record', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  await registerCompletionsUpstream(repo);
  const dumpStubs = installDumpStubs(initDumpStore, initDumpBroker);

  await withMockedFetch(
    () => Promise.resolve(completionStream()),
    async () => {
      const response = await requestApp('/v1/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'davinci-002', prompt: 'hello', stream: true }),
      });
      assertEquals(response.status, 200);
      await response.text();
    },
  );

  await flushAsyncWork();

  const usage = await repo.usage.listAll();
  assertEquals(usage.length, 1);
  assertEquals(usage[0]?.tokens.input, 4);
  assertEquals(usage[0]?.tokens.output, 2);

  const performance = await repo.performance.listAll();
  const requestTotal = performance.find(row => row.metricScope === 'request_total');
  const upstreamSuccess = performance.find(row => row.metricScope === 'upstream_success');
  assertExists(requestTotal);
  assertExists(upstreamSuccess);
  assertEquals(requestTotal.stream, true);
  assertEquals(requestTotal.requests, 1);
  assertEquals(requestTotal.errors, 0);
  assertEquals(upstreamSuccess.stream, true);
  assertEquals(upstreamSuccess.requests, 1);
  assertEquals(upstreamSuccess.errors, 0);

  assertEquals(dumpStubs.stored.length, 1);
  const dump = dumpStubs.stored[0]!.record;
  assertEquals(dump.meta.path, '/v1/completions');
  assertEquals(dump.meta.status, 200);
  assertEquals(dump.meta.model, 'davinci-002');
  assertEquals(dump.meta.inputTokens, 4);
  assertEquals(dump.meta.outputTokens, 2);
  // Streaming: dump stores the protocol frames the gateway saw from
  // upstream BEFORE transformFrame ran. The fixture stream emits two
  // content events, one usage-only event (which the client did not opt
  // into and so it was stripped from the forwarded stream), and a done
  // terminator.
  assertEquals(dump.response.body.type, 'stream');
  if (dump.response.body.type === 'stream') {
    const frames = dump.response.body.events.map(e => e.frame);
    assertEquals(frames.length, 4);
    assertEquals(frames[0]?.type, 'event');
    assertEquals(frames[1]?.type, 'event');
    assertEquals(frames[2]?.type, 'event');
    // Upstream's usage chunk is preserved in the dump even though it was
    // stripped from the client-facing stream.
    const usageFrame = frames[2];
    if (usageFrame?.type === 'event') {
      const event = usageFrame.event as { choices: unknown[]; usage: { prompt_tokens: number } };
      assertEquals(event.choices.length, 0);
      assertEquals(event.usage.prompt_tokens, 4);
    }
    assertEquals(frames[3]?.type, 'done');
  }
});
