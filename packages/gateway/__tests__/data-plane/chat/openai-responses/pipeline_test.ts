import { expect, test } from 'vitest';

import { headers, imageUpstream, key, readHttpBytes, readWireJson, responsesFixture, responsesUpstream, wireEvents, type WireRequest } from './fixture.ts';
import { syntheticEventsFromResult } from '../../../../src/data-plane/chat/openai-responses/items/output.ts';
import { LayeredOpenAIResponsesStatefulStore, MemoryOpenAIResponsesStatefulBacking } from '../../../../src/data-plane/chat/openai-responses/items/store.ts';
import type { OpenAIImagesGenerationsPayload } from '@floway-dev/protocols/openai-images';
import type { OpenAIResponsesOutputItemEx, OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';

const modelOutput = (output: OpenAIResponsesOutputItemEx[], usage = { input_tokens: 3, output_tokens: 4, total_tokens: 7 }): OpenAIResponsesResultEx => ({
  id: 'resp_upstream', object: 'response', model: 'test-model', status: 'completed', error: null, incomplete_details: null, output, usage,
});

const message = (text: string): OpenAIResponsesOutputItemEx => ({
  type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', annotations: [], text }],
});

const eventsReply = (response = modelOutput([message('answer')])) => wireEvents(syntheticEventsFromResult(response));

test('HTTP Responses hydrates previous_response_id and commits only store-enabled turns', async () => {
  const backing = new MemoryOpenAIResponsesStatefulBacking();
  const calls: WireRequest[] = [];
  const mock = responsesFixture([responsesUpstream('responses', request => {
    calls.push(request);
    return eventsReply();
  })], mode => {
    if (mode.kind !== 'http') throw new Error('Expected HTTP Responses mode');
    return new LayeredOpenAIResponsesStatefulStore({ apiKeyId: key, reads: [backing], writes: mode.store === false ? [] : [backing] });
  });
  const first = mock.request({ model: 'test-model', input: 'first prompt' });
  const firstResponse = (await first.result)['response.http'];
  expect(firstResponse.status).toBe(200);
  expect(firstResponse.headers).toContainEqual(['x-reasoning-included', 'true']);
  expect(firstResponse.headers).toContainEqual(headers[0]);
  const firstBody = JSON.parse((await readHttpBytes(firstResponse.body)).utf8());
  expect(firstBody).toMatchObject({ object: 'response', store: true, output: [expect.objectContaining({ type: 'reasoning' }), expect.objectContaining({ id: 'msg_1' })] });
  expect(await backing.lookupSnapshot(key, firstBody.id)).toMatchObject({ itemIds: expect.arrayContaining(['msg_1']) });
  expect(await first.done).toEqual({ ok: true });

  const second = mock.request({ model: 'test-model', input: 'second prompt', previous_response_id: firstBody.id, store: false });
  const secondBody = JSON.parse((await readHttpBytes((await second.result)['response.http'].body)).utf8());
  expect(secondBody.store).toBe(false);
  expect(await backing.lookupSnapshot(key, secondBody.id)).toBeNull();
  expect(calls[0]?.headers.get('user-agent')).toBe('Floway test');
  expect(calls[0]?.headers.has('x-ignored')).toBe(false);
  expect(calls[1]?.payload).not.toHaveProperty('previous_response_id');
  expect(calls[1]?.payload.input).toEqual([
    expect.objectContaining({ role: 'user', content: 'first prompt' }),
    expect.objectContaining({ role: 'assistant', id: 'msg_1' }),
    expect.objectContaining({ role: 'user', content: 'second prompt' }),
  ]);
  expect(await second.done).toEqual({ ok: true });
  expect(mock.usage).toHaveLength(2);
});

test('native HTTP compact reads scalar usage and preserves its compact resource', async () => {
  const mock = responsesFixture([responsesUpstream('responses', ({ action, payload }) => {
    expect(action).toBe('compact');
    expect(payload).not.toHaveProperty('stream');
    return Response.json({
      id: 'cmp_upstream', object: 'response.compaction',
      output: [{ type: 'compaction', id: 'cmp_1', encrypted_content: 'upstream-opaque' }],
      usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
    });
  })]);
  const handle = mock.request({ model: 'test-model', input: 'compact', stream: true }, 'compact');
  const response = (await handle.result)['response.http'];
  expect(response.status).toBe(200);
  expect(response.headers).not.toContainEqual(['x-reasoning-included', 'true']);
  const body = JSON.parse((await readHttpBytes(response.body)).utf8());
  expect(body).toMatchObject({
    object: 'response.compaction', output: [expect.objectContaining({ id: 'cmp_1', type: 'compaction' })],
    usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
  });
  expect(await handle.done).toEqual({ ok: true });
  expect(mock.usage).toEqual([expect.objectContaining({ modelKey: 'test-model', requests: 1 })]);
  expect(mock.performance).toEqual([expect.objectContaining({ kind: 'neutral' })]);
  const entered = mock.events.filter(event => event.k === 'enter');
  expect(entered.map(event => event.pipeline)).toEqual(expect.arrayContaining([
    'openai-responses.compact.ingress', 'openai-responses.body', 'openai-responses.egress',
  ]));
  expect(entered.map(event => event.name)).toContain('answerWebSocketWarmup');
  expect(entered.map(event => event.name)).toContain('serializeItems');
});

test('compact shim retries a textless turn, reports aggregate usage and records each call', async () => {
  const calls: WireRequest[] = [];
  const mock = responsesFixture([responsesUpstream('responses', request => {
    calls.push(request);
    expect(request.action).toBe('generate');
    expect(request.payload.store).toBe(false);
    return eventsReply(modelOutput(calls.length === 1 ? [] : [message('summary')]));
  }, ['openai-responses-compact-shim'])]);
  const handle = mock.request({ model: 'test-model', input: 'make compact' }, 'compact');
  const response = (await handle.result)['response.http'];
  expect(response.status).toBe(200);
  const body = JSON.parse((await readHttpBytes(response.body)).utf8());
  expect(body.usage).toMatchObject({ input_tokens: 6, output_tokens: 8, total_tokens: 14 });
  expect(calls[0]?.payload.input[0]).toMatchObject({ role: 'user', content: 'make compact' });
  expect(calls[1]?.payload.input[0]).toMatchObject({ role: 'system' });
  expect(await handle.done).toEqual({ ok: true });
  expect(mock.usage.map(row => row.requests)).toEqual([1, 1]);
  expect(mock.performance).toHaveLength(2);
  const entered = mock.events.filter(event => event.k === 'enter');
  const egresses = entered.filter(event => event.edge === 'into' && event.pipeline.endsWith('.egress'));
  expect(egresses.map(event => event.pipeline)).toEqual(['openai-responses.egress', 'openai-responses.egress']);
});

test('a provider stream failure keeps its JSON resource and marks performance failed', async () => {
  const mock = responsesFixture([responsesUpstream('responses', () =>
    eventsReply({ ...modelOutput([]), status: 'failed', error: { code: 'server_error', message: 'mock failure' } }))]);
  const handle = mock.request({ model: 'test-model', input: 'try' });
  const response = (await handle.result)['response.http'];
  expect(response.status).toBe(200);
  expect(JSON.parse((await readHttpBytes(response.body)).utf8())).toMatchObject({ status: 'failed', error: { message: 'mock failure' } });
  expect(await handle.done).toEqual({ ok: true });
  expect(mock.usage).toHaveLength(1);
  expect(mock.performance).toEqual([expect.objectContaining({ kind: 'zero-output-error' })]);
});

test('streamed Responses includes the reasoning marker, terminal resource and done trailer', async () => {
  const mock = responsesFixture([responsesUpstream('responses', () => eventsReply())]);
  const handle = mock.request({ model: 'test-model', input: 'stream', stream: true });
  const response = (await handle.result)['response.http'];
  expect(response.status).toBe(200);
  expect(response.headers).toContainEqual(['x-reasoning-included', 'true']);
  const body = (await readHttpBytes(response.body)).utf8();
  expect(body).toContain('event: response.completed');
  expect(body).toContain('data: [DONE]');
  expect(await handle.done).toEqual({ ok: true });
  expect(mock.usage).toHaveLength(1);
});

test('a ReAct image call retries 429, streams previews and settles separately from both chat rounds', async () => {
  const imageRequests: OpenAIImagesGenerationsPayload[] = [];
  const images = imageUpstream('images', 'test-model', async (_url, init) => {
    imageRequests.push(await readWireJson(init.body));
    if (imageRequests.length === 1) {
      return Response.json({ error: { code: 'rate_limit_exceeded', message: 'retry' } }, { status: 429, headers: { 'retry-after-ms': '1' } });
    }
    return new Response([
      'data: {"type":"image_generation.partial_image","partial_image_index":0,"b64_json":"cHJldmlldw=="}\n\n',
      'data: {"type":"image_generation.completed","b64_json":"ZmluYWw=","usage":{"input_tokens":3,"output_tokens":5,"total_tokens":8}}\n\n',
    ].join(''), { headers: { 'content-type': 'text/event-stream' } });
  });
  const turns: WireRequest[] = [];
  const chat = responsesUpstream('chat', request => {
    turns.push(request);
    if (turns.length === 2) return eventsReply(modelOutput([message('The image is ready.')]));
    return eventsReply(modelOutput([{
      type: 'function_call', id: 'fc_test', call_id: 'call_test', status: 'completed',
      name: 'image_generation', arguments: '{"prompt":"an apple"}',
    }]));
  }, ['openai-responses-image-generation-shim']);
  const mock = responsesFixture([chat, images]);
  const handle = mock.request({
    model: 'test-model', input: 'draw something', stream: true,
    tools: [{ type: 'image_generation', model: 'test-model', partial_images: 1 }],
  });
  const response = (await handle.result)['response.http'];
  expect(response.status).toBe(200);
  const body = (await readHttpBytes(response.body)).utf8();
  expect(body).toContain('response.image_generation_call.partial_image');
  expect(body).toContain('cHJldmlldw==');
  expect(body).toContain('ZmluYWw=');
  expect(body).toContain('The image is ready.');
  expect(imageRequests).toEqual([
    expect.objectContaining({ prompt: 'an apple', stream: true, partial_images: 1 }),
    expect.objectContaining({ prompt: 'an apple', stream: true, partial_images: 1 }),
  ]);
  expect(turns[1]?.payload.input).toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: 'call_test' }));
  expect(await handle.done).toEqual({ ok: true });
  expect(mock.usage.map(row => row.upstream).sort()).toEqual(['chat', 'chat', 'images', 'images']);
  expect(mock.performance).toHaveLength(4);
  const recordIds = mock.events.flatMap(event => event.k === 'deferred' && event.name === 'call.record' ? [event.deferredId] : []);
  const records = mock.events.flatMap(event => event.k === 'settled' && event.ok && recordIds.includes(event.deferredId) ? [event.value] : []);
  expect(records).toHaveLength(4);
  expect(records).toContainEqual(expect.objectContaining({ upstreamId: 'images', status: 429, failed: true }));
  expect(mock.performance).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'neutral', dimensions: expect.objectContaining({ operation: 'image_generation' }) }),
    expect.objectContaining({ kind: 'zero-output-error', dimensions: expect.objectContaining({ operation: 'image_generation' }) }),
    expect.objectContaining({ sample: expect.objectContaining({ operation: 'chat' }) }),
  ]));
});
