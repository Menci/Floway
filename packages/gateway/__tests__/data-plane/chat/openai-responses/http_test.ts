import { expect, test, vi } from 'vitest';

import { TEST_OPENAI_RESPONSES_RETENTION_SECONDS } from './test-policy.ts';
import { missingRequiredCompactionKeys, responseOnlyKeysAdded } from './test-required-resource-keys.ts';
import { buildCustomUpstreamRecord, requestAppWithWarmModels, setupAppTest, sseResponse } from '../../../test-utils/app.ts';
import { flushBackground } from '../../../test-utils/background-tracker.ts';
import { openaiResponsesResultToEvents, parseOpenAIResponsesStream, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';
import { withMockedFetch } from '@floway-dev/test-utils';

const completed = (id = 'resp_provider'): OpenAIResponsesResultEx => ({
  id,
  object: 'response',
  model: 'test-model',
  status: 'completed',
  output: [{
    type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'hi', annotations: [] }],
  }],
  error: null,
  incomplete_details: null,
  usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
});

const setup = async () => {
  const { apiKey, repo } = await setupAppTest({
    copilotUpstream: buildCustomUpstreamRecord({
      flagOverrides: { 'openai-responses-compact-shim': false },
      config: { baseUrl: 'https://responses.example.test', apiKey: '', ingressHeadersRules: [], endpoints: { openaiResponses: {} } },
    }),
  });
  const persistentKey = { ...apiKey, openaiResponsesRetentionSeconds: TEST_OPENAI_RESPONSES_RETENTION_SECONDS };
  await repo.apiKeys.save(persistentKey);
  const post = (body: Record<string, unknown>, path = '/v1/responses', headers: Record<string, string> = {}) =>
    requestAppWithWarmModels(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ model: 'test-model', ...body }),
    });
  const serve = async (testBody: () => Promise<void>, provider?: (request: Request) => Promise<Response>) => {
    await withMockedFetch(async request => {
      if (new URL(request.url).pathname === '/v1/models') return Response.json({ data: [{ id: 'test-model' }] });
      if (provider) return await provider(request);
      expect(new URL(request.url).pathname).toBe('/v1/responses');
      return sseResponse(openaiResponsesResultToEvents(completed()).map(frame => ({ data: frame.event })));
    }, testBody);
    await flushBackground();
  };
  return { repo, post, serve };
};

test('Responses Lite input items keep their position and metadata across HTTP continuation', async () => {
  const { post, serve } = await setup();
  const input = [
    { type: 'additional_tools', role: 'developer', id: 'at_lite', tools: [{ type: 'namespace', name: 'functions', description: '', tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }] }] },
    { type: 'message', role: 'developer', id: 'msg_base', content: [{ type: 'input_text', text: 'Caller base instructions' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] } },
    { type: 'message', role: 'user', content: 'First turn' },
  ];
  const bodies: CanonicalOpenAIResponsesPayload[] = [];
  const send = async (body: Record<string, unknown>) => {
    const response = await post({ store: true, ...body }, '/v1/responses', { 'x-openai-internal-codex-responses-lite': 'true' });
    expect(response.status).toBe(200);
    return await response.json() as OpenAIResponsesResultEx;
  };
  await serve(async () => {
    const first = await send({ input });
    await send({ previous_response_id: first.id, input: [{ role: 'user', content: 'Second turn' }] });
  }, async request => {
    expect(new URL(request.url).pathname).toBe('/v1/responses');
    bodies.push(await request.json() as CanonicalOpenAIResponsesPayload);
    return sseResponse(openaiResponsesResultToEvents(completed(`resp_lite_${bodies.length}`)).map(frame => ({ data: frame.event })));
  });
  expect(bodies[0].input).toEqual(input);
  expect(bodies[1].input.slice(0, input.length)).toEqual(input);
  for (const body of bodies) {
    expect(body.tools).toBeUndefined();
    expect(body.instructions).toBeUndefined();
  }
});

test('POST /v1/responses completes an SSE stream with a client-owned response id', async () => {
  const { post, serve } = await setup();
  await serve(async () => {
    const response = await post({ input: 'hello', stream: true });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const body = await response.text();
    expect(body).toContain('event: response.completed');
    expect(body.match(/"id":"(resp_[A-Za-z0-9_-]+)"/)?.[1]).toMatch(/^resp_/);
    expect(body).not.toContain('"id":"resp_provider"');
    expect(body.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(body.endsWith('data: [DONE]\n\n')).toBe(true);
  });
});

test.each([false, true])('Responses preserves successful upstream headers and declares inclusive reasoning usage (stream: %s)', async stream => {
  const { post, serve } = await setup();
  await serve(async () => {
    const response = await post({ input: 'hello', store: false, stream });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-reasoning-included')).toBe('true');
    expect(response.headers.get('x-native')).toBe('trace');
    await response.text();
  }, async () => {
    const upstream = sseResponse(openaiResponsesResultToEvents(completed()).map(frame => ({ data: frame.event })));
    upstream.headers.set('x-reasoning-included', 'upstream-value');
    upstream.headers.set('x-native', 'trace');
    return upstream;
  });
});

test.each([false, true])('Responses preserves the native error notification and the announced resource (stream: %s)', async stream => {
  const { post, serve } = await setup();
  const error = { type: 'error', sequence_number: 3, error: { code: 'vendor_failure', message: 'native failure', provider_specific_fields: { trace: 'native' } } };
  const upstream = { ...completed(), status: 'failed' as const, error: error.error, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
  const item = upstream.output[0];
  await serve(async () => {
    const response = await post({ input: 'hello', store: false, stream });
    expect(response.status).toBe(stream ? 200 : 502);
    if (!stream) {
      const { sequence_number: _sequenceNumber, ...body } = error;
      expect(await response.json()).toEqual(body);
      return;
    }
    if (response.body === null) throw new Error('Expected the Responses stream');
    const frames = await Array.fromAsync(parseOpenAIResponsesStream(response.body));
    const events = frames.flatMap(frame => frame.type === 'event' ? [frame.event] : []);
    expect(events.map(event => event.type)).toEqual([
      'response.created',
      'response.output_item.added', 'response.output_item.done',
      'response.output_item.added', 'response.output_item.done',
      'error', 'response.failed',
    ]);
    expect(events.map(event => event.sequence_number)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(events[5]).toEqual({ ...error, sequence_number: 5 });
    const created = events[0];
    const failed = events.at(-1);
    if (created.type !== 'response.created' || failed?.type !== 'response.failed') throw new Error('Expected Responses lifecycle events');
    expect(failed.response).toMatchObject({
      id: created.response.id,
      output: [expect.objectContaining({ type: 'reasoning', encrypted_content: expect.any(String) }), item],
      status: 'failed', error: error.error, usage: upstream.usage,
    });
    expect(failed.response.id).not.toBe(upstream.id);
  }, async () => sseResponse([
    { data: { type: 'response.created', sequence_number: 0, response: { ...upstream, status: 'in_progress', output: [], error: null } } },
    { data: { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item } },
    { data: { type: 'response.output_item.done', sequence_number: 2, output_index: 0, item } },
    { data: error },
    { data: { type: 'response.failed', sequence_number: 4, response: upstream } },
  ]));
});

test.each([
  { error: { type: 'error', error: { type: 'invalid_request_error', code: null, message: 'bad tools', param: 'tools' } }, status: 400 },
  { error: { type: 'error', code: 'rate_limit_exceeded', message: 'slow down', param: null }, status: 429 },
  { error: { type: 'error', code: null, message: 'bad key', param: null, provider_specific_fields: { type: 'authentication_error' } }, status: 401 },
])('Responses assigns HTTP $status to a collected upstream error', async ({ error, status }) => {
  const { post, serve } = await setup();
  await serve(async () => {
    const response = await post({ input: 'hello', store: false });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(error);
  }, async () => sseResponse([{ data: { ...error, sequence_number: 0 } }]));
});

test('Responses retains native HTTP error status, headers and JSON fields', async () => {
  const { post, serve } = await setup();
  const error = { error: { message: 'native', stack: 'provider-owned', custom: true } };
  await serve(async () => {
    const response = await post({ input: 'hello', store: false });
    expect(response.status).toBe(429);
    expect(response.headers.get('x-native')).toBe('trace');
    expect(response.headers.get('x-reasoning-included')).toBeNull();
    expect(await response.json()).toEqual(error);
  }, async () => Response.json(error, { status: 429, headers: { 'x-native': 'trace' } }));
});

test('POST /v1/responses surfaces an output-item persistence failure before completion', async () => {
  const { repo, post, serve } = await setup();
  const failure = new Error('simulated item persistence failure');
  const persistence = vi.spyOn(repo.openaiResponsesItems, 'insertMany').mockRejectedValue(failure);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await serve(async () => {
      const response = await post({ input: 'hello', store: true, stream: true });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body.endsWith('data: [DONE]\n\n')).toBe(true);
      const stream = new Response(body).body;
      if (stream === null) throw new Error('Expected encoded Responses events');
      const frames = await Array.fromAsync(parseOpenAIResponsesStream(stream));
      const events = frames.flatMap(frame => frame.type === 'event' ? [frame.event] : []);
      const created = events.find(event => event.type === 'response.created');
      const notification = events.at(-2);
      expect(notification).toMatchObject({
        type: 'error',
        error: { code: 'internal_error', message: failure.message, provider_specific_fields: { stack: failure.stack } },
      });
      expect(events.at(-1)).toMatchObject({
        type: 'response.failed',
        response: { id: created?.response.id, status: 'failed', error: { message: failure.message } },
      });
      expect(events.some(event => event.type === 'response.completed')).toBe(false);
    });
    expect(log).toHaveBeenCalledWith('[pipeline-response]', failure);
  } finally {
    persistence.mockRestore();
    log.mockRestore();
  }
});

test('POST /v1/responses exposes the original snapshot persistence panic in its HTTP error', async () => {
  const { repo, post, serve } = await setup();
  const cause = new Error('simulated database failure');
  const failure = new Error('simulated snapshot persistence failure', { cause });
  const persistence = vi.spyOn(repo.openaiResponsesSnapshots, 'insert').mockRejectedValue(failure);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await serve(async () => {
      const response = await post({ input: 'hello', store: true });
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({
        error: {
          type: 'internal_error',
          message: failure.message,
          provider_specific_fields: { stack: failure.stack, cause: { message: cause.message, stack: cause.stack } },
        },
      });
    });
    expect(log).toHaveBeenCalledWith('[pipeline-response]', failure);
  } finally {
    persistence.mockRestore();
    log.mockRestore();
  }
});

test.each([true, false])('POST /v1/responses/compact retains the compaction resource (usage reported: %s)', async reportsUsage => {
  const { post, serve } = await setup();
  const upstream = {
    id: 'resp_compaction', object: 'response.compaction',
    output: [{ type: 'compaction', id: 'cmp_1', encrypted_content: 'ENC' }],
    usage: reportsUsage ? { input_tokens: 12, output_tokens: 3, total_tokens: 15 } : null,
  };
  await serve(async () => {
    const response = await post({ input: [{ type: 'message', role: 'user', content: 'kept' }], store: false, temperature: 0.3 }, '/v1/responses/compact');
    const body = await response.json() as Record<string, unknown>;
    if (!reportsUsage) {
      expect(response.status).toBe(502);
      expect(body).toMatchObject({ error: { type: 'internal_error', message: expect.stringContaining('no token usage') } });
      return;
    }
    expect(response.status).toBe(200);
    expect(missingRequiredCompactionKeys(body)).toEqual([]);
    expect(body.created_at).toEqual(expect.any(Number));
    expect(body.usage).toEqual({
      input_tokens: 12, output_tokens: 3, total_tokens: 15,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
    });
    expect(responseOnlyKeysAdded(upstream, body)).toEqual([]);
  }, async request => {
    expect(new URL(request.url).pathname).toBe('/v1/responses/compact');
    return Response.json(upstream);
  });
});
