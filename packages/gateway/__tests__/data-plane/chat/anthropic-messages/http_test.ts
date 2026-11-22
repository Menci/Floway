import { expect, test, vi } from 'vitest';

import { MODEL_CATALOG_REVISION } from '../../../../src/data-plane/providers/models-cache.ts';
import { modelsRefreshInputs } from '../../../../src/repo/models-refresh-inputs.ts';
import { saveUpstreamForTest } from '../../../repo/upstreams.ts';
import {
  buildCustomUpstreamRecord,
  requestAppWithWarmModels,
  setupAppTest,
  sseAnthropicMessagesResponse,
} from '../../../test-utils/app.ts';
import { stubProviderModel, withMockedFetch } from '@floway-dev/test-utils';

const seedModel = async (
  endpoints: { readonly anthropicMessages?: Record<string, never> } = { anthropicMessages: {} },
): Promise<Awaited<ReturnType<typeof setupAppTest>>> => {
  const appTest = await setupAppTest();
  await appTest.repo.upstreams.deleteAll();
  const model = stubProviderModel({
    id: 'test-model',
    upstreamModelId: 'test-model',
    kind: 'chat',
    endpoints,
    limits: { max_context_window_tokens: 128000, max_output_tokens: 4096 },
  });
  const record = buildCustomUpstreamRecord({
    id: 'up_messages',
    name: 'Messages Provider',
    config: {
      baseUrl: 'https://messages.pipeline.example.com',
      ingressHeadersRules: [],
      apiKey: 'sk-messages',
      endpoints,
      modelsFetch: { enabled: false, authStyle: 'x-api-key' },
    },
  });
  await saveUpstreamForTest(appTest.repo.upstreams, record);
  const stored = await appTest.repo.upstreams.getById(record.id);
  if (stored === null) throw new Error('missing seeded messages upstream');
  await appTest.repo.upstreams.publishModelsRefresh({
    id: stored.id,
    configVersion: stored.configVersion,
    cacheEpoch: 0,
    refreshInputs: modelsRefreshInputs(stored),
    cache: { revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now(), models: [model] },
  });
  return appTest;
};

const message = (text = 'hi') => ({
  id: 'msg_http',
  type: 'message',
  role: 'assistant',
  model: 'test-model',
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 4, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null, cache_creation: null, server_tool_use: null, service_tier: 'standard', inference_geo: null, output_tokens_details: null },
});

test('POST /v1/messages returns one JSON body when stream is omitted', async () => {
  const appTest = await seedModel();
  await withMockedFetch(
    () => sseAnthropicMessagesResponse(message()),
    async () => {
      const response = await requestAppWithWarmModels('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': appTest.apiKey.key },
        body: JSON.stringify({ model: 'test-model', max_tokens: 32, messages: [{ role: 'user', content: 'hello' }] }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')?.split(';')[0]).toBe('application/json');
      const body = await response.json() as { role: string; content: unknown[] };
      expect(body.role).toBe('assistant');
      expect(body.content).toContainEqual({ type: 'text', text: 'hi', citations: null });
    },
  );
});

test('POST /v1/messages streams Anthropic SSE with the ping keepalive format', async () => {
  const appTest = await seedModel();
  await withMockedFetch(
    () => sseAnthropicMessagesResponse(message()),
    async () => {
      const response = await requestAppWithWarmModels('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': appTest.apiKey.key },
        body: JSON.stringify({ model: 'test-model', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hello' }] }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const text = await response.text();
      expect(text).toContain('event: message_start');
      expect(text).toContain('event: message_stop');
    },
  );
});

test('POST /v1/messages answers the Claude Code model-validation probe without dialing', async () => {
  const appTest = await seedModel();
  const dial = vi.fn();
  await withMockedFetch(
    dial.mockImplementation(() => { throw new Error('probe reached upstream'); }),
    async () => {
      const response = await requestAppWithWarmModels('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': appTest.apiKey.key, 'user-agent': 'claude-cli/2.1.226 (external, cli)' },
        body: JSON.stringify({
          model: 'test-model', max_tokens: 1,
          system: [{ citations: null, type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
          messages: [{ role: 'user', content: [{ citations: null, type: 'text', text: 'Hi', cache_control: { type: 'ephemeral' } }] }],
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ model: 'test-model', stop_reason: 'max_tokens', usage: { input_tokens: 0, output_tokens: 0 } });
      expect(dial).not.toHaveBeenCalled();
      expect(await appTest.repo.usage.listAll()).toHaveLength(1);
    },
  );
});

test('POST /v1/messages rejects body anthropic_beta before routing', async () => {
  const appTest = await seedModel();
  const response = await requestAppWithWarmModels('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': appTest.apiKey.key },
    body: JSON.stringify({ model: 'test-model', max_tokens: 32, anthropic_beta: ['x'], messages: [{ role: 'user', content: 'hello' }] }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { param: 'anthropic_beta', type: 'invalid_request_error' } });
});

test('POST /v1/messages/count_tokens forwards status, retry and request-id while stripping set-cookie', async () => {
  const appTest = await seedModel();
  const body = '{"error":{"type":"rate_limit_error","message":"wait"}}';
  await withMockedFetch(
    () => new Response(body, { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '17', 'request-id': 'req-count', 'set-cookie': 'private=1' } }),
    async () => {
      const response = await requestAppWithWarmModels('/v1/messages/count_tokens', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': appTest.apiKey.key },
        body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hello' }] }),
      });
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('17');
      expect(response.headers.get('request-id')).toBe('req-count');
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(await response.text()).toBe(body);
    },
  );
});

test('POST /v1/messages does not fail over after a response stream opens and breaks', async () => {
  const appTest = await seedModel();
  const encoder = new TextEncoder();
  await withMockedFetch(
    () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_break","type":"message","role":"assistant","model":"test-model","content":[],"stop_reason":null,"stop_sequence":null,"container":null,"diagnostics":null,"stop_details":null,"usage":{"cache_creation":null,"cache_creation_input_tokens":null,"cache_read_input_tokens":null,"inference_geo":null,"output_tokens_details":null,"server_tool_use":null,"service_tier":"standard","input_tokens":1,"output_tokens":0}}}\n\n'));
        setTimeout(() => controller.error(new Error('connection reset after message_start')), 0);
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    async () => {
      const response = await requestAppWithWarmModels('/v1/messages', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': appTest.apiKey.key },
        body: JSON.stringify({ model: 'test-model', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hello' }] }),
      });
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).toContain('event: message_start');
      expect(text).toContain('event: error');
      expect(text).toContain('connection reset after message_start');
    },
  );
});
