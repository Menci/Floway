import { expect, test } from 'vitest';

import { headers, http, key, providerResponses, responsesFixture, upstream } from './fixture.ts';
import { syntheticEventsFromResult } from '../../../../src/data-plane/chat/openai-responses/items/output.ts';
import { LayeredOpenAIResponsesStatefulStore, MemoryOpenAIResponsesStatefulBacking } from '../../../../src/data-plane/chat/openai-responses/items/store.ts';
import { readHttpBytes } from '../../../../src/data-plane/pipeline/non-chat.ts';
import { Bytes, compose, defineEnding, type StageEnv } from '@floway-dev/pipeline';
import type { OpenAIImagesGenerationsPayload } from '@floway-dev/protocols/openai-images';
import type { OpenAIResponsesOutputItemEx, OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';
import type { ProviderHttpOutput, ProviderInput, ProviderResponsesInput, ProviderResponsesOutput, ProviderServices } from '@floway-dev/provider';

const modelOutput = (output: OpenAIResponsesOutputItemEx[], usage = { input_tokens: 3, output_tokens: 4, total_tokens: 7 }): OpenAIResponsesResultEx => ({
  id: 'resp_upstream', object: 'response', model: 'test-model', status: 'completed', error: null, incomplete_details: null, output, usage,
});

const message = (text: string): OpenAIResponsesOutputItemEx => ({
  type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', annotations: [], text }],
});

const eventsReply = (env: StageEnv, response = modelOutput([message('answer')])): ProviderResponsesOutput => ({
  ...http(),
  'response.modelKey': 'native-responses',
  'response.events': env.createStream({ label: 'stub Responses events', iterate: () => syntheticEventsFromResult(response) }),
  'response.result': undefined,
});

test('HTTP Responses hydrates previous_response_id and commits only store-enabled turns', async () => {
  const backing = new MemoryOpenAIResponsesStatefulBacking();
  const calls: ProviderResponsesInput[] = [];
  const mock = responsesFixture([upstream('responses', {
    openaiResponses: providerResponses((facts, env) => {
      calls.push(facts);
      return eventsReply(env);
    }),
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
  expect(calls[0]?.['request.headers']).toEqual([['user-agent', 'Floway test']]);
  expect(calls[1]?.['request.payload']).not.toHaveProperty('previous_response_id');
  expect(calls[1]?.['request.payload'].input).toEqual([
    expect.objectContaining({ role: 'user', content: 'first prompt' }),
    expect.objectContaining({ role: 'assistant', id: 'msg_1' }),
    expect.objectContaining({ role: 'user', content: 'second prompt' }),
  ]);
  expect(await second.done).toEqual({ ok: true });
  expect(mock.usage).toHaveLength(2);
});

test('native HTTP compact reads scalar usage and preserves its compact resource', async () => {
  const mock = responsesFixture([upstream('responses', {
    openaiResponses: providerResponses(facts => {
      expect(facts['request.action']).toBe('compact');
      return {
        ...http(),
        'response.modelKey': 'native-compact',
        'response.events': undefined,
        'response.result': {
          id: 'cmp_upstream', object: 'response.compaction',
          output: [{ type: 'compaction', id: 'cmp_1', encrypted_content: 'upstream-opaque' }],
          usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
        },
      };
    }),
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
  expect(mock.usage).toEqual([expect.objectContaining({ modelKey: 'native-compact', requests: 1 })]);
  expect(mock.performance).toEqual([expect.objectContaining({ kind: 'neutral' })]);
});

test('compact shim retries a textless turn, reports aggregate usage and records each call', async () => {
  const calls: ProviderResponsesInput[] = [];
  const mock = responsesFixture([upstream('responses', {
    openaiResponses: providerResponses((facts, env) => {
      calls.push(facts);
      expect(facts['request.action']).toBe('generate');
      expect(facts['request.payload'].store).toBe(false);
      return eventsReply(env, modelOutput(calls.length === 1 ? [] : [message('summary')]));
    }),
  }, ['openai-responses-compact-shim'])]);
  const handle = mock.request({ model: 'test-model', input: 'make compact' }, 'compact');
  const response = (await handle.result)['response.http'];
  expect(response.status).toBe(200);
  const body = JSON.parse((await readHttpBytes(response.body)).utf8());
  expect(body.usage).toMatchObject({ input_tokens: 6, output_tokens: 8, total_tokens: 14 });
  expect(calls[0]?.['request.payload'].input[0]).toMatchObject({ role: 'user', content: 'make compact' });
  expect(calls[1]?.['request.payload'].input[0]).toMatchObject({ role: 'system' });
  expect(await handle.done).toEqual({ ok: true });
  expect(mock.usage.map(row => row.requests)).toEqual([1, 1]);
  expect(mock.performance).toHaveLength(1);
});

test('a provider stream failure keeps its JSON resource and marks performance failed', async () => {
  const mock = responsesFixture([upstream('responses', {
    openaiResponses: providerResponses((_facts, env) =>
      eventsReply(env, { ...modelOutput([]), status: 'failed', error: { code: 'server_error', message: 'mock failure' } })),
  })]);
  const handle = mock.request({ model: 'test-model', input: 'try' });
  const response = (await handle.result)['response.http'];
  expect(response.status).toBe(200);
  expect(JSON.parse((await readHttpBytes(response.body)).utf8())).toMatchObject({ status: 'failed', error: { message: 'mock failure' } });
  expect(await handle.done).toEqual({ ok: true });
  expect(mock.usage).toHaveLength(1);
  expect(mock.performance).toEqual([expect.objectContaining({ kind: 'zero-output-error' })]);
});

test('streamed Responses includes the reasoning marker, terminal resource and done trailer', async () => {
  const mock = responsesFixture([upstream('responses', { openaiResponses: providerResponses((_facts, env) => eventsReply(env)) })]);
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
  type ImagesInput = ProviderInput<Omit<OpenAIImagesGenerationsPayload, 'model'>>;
  const imageRequests: ImagesInput[] = [];
  const imagePipeline = compose<ImagesInput, ProviderHttpOutput, ProviderServices>('test.images', {
    stages: [],
    ending: defineEnding<ImagesInput, ProviderHttpOutput>({
      name: 'stubImages',
      request: { needs: ['provider.model', 'request.headers', 'request.payload'] },
      return: { provides: ['response.http', 'response.modelKey'] },
      execute: async facts => {
        imageRequests.push(facts);
        if (imageRequests.length === 1) {
          const response = http(429, Bytes.fromUtf8('{"error":{"code":"rate_limit_exceeded","message":"retry"}}'))['response.http'];
          return {
            'response.http': { ...response, headers: [['retry-after-ms', '1']] },
            'response.modelKey': 'native-image',
          };
        }
        return {
          ...http(200, Bytes.fromUtf8([
            'data: {"type":"image_generation.partial_image","partial_image_index":0,"b64_json":"cHJldmlldw=="}\n\n',
            'data: {"type":"image_generation.completed","b64_json":"ZmluYWw=","usage":{"input_tokens":3,"output_tokens":5,"total_tokens":8}}\n\n',
          ].join(''))),
          'response.modelKey': 'native-image',
        };
      },
    }),
  });
  const turns: ProviderResponsesInput[] = [];
  const responsesPipeline = providerResponses((facts, env) => {
    turns.push(facts);
    if (turns.length === 2) return eventsReply(env, modelOutput([message('The image is ready.')]));
    return eventsReply(env, modelOutput([{
      type: 'function_call', id: 'fc_test', call_id: 'call_test', status: 'completed',
      name: 'image_generation', arguments: '{"prompt":"an apple"}',
    }]));
  });
  const mock = responsesFixture([
    upstream('chat', { openaiResponses: responsesPipeline }, ['openai-responses-image-generation-shim']),
    upstream('images', { openaiImagesGenerations: imagePipeline }, [], 'image'),
  ]);
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
  expect(imageRequests.map(call => call['request.payload'])).toEqual([
    expect.objectContaining({ prompt: 'an apple', stream: true, partial_images: 1 }),
    expect.objectContaining({ prompt: 'an apple', stream: true, partial_images: 1 }),
  ]);
  expect(turns[1]?.['request.payload'].input).toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: 'call_test' }));
  expect(await handle.done).toEqual({ ok: true });
  expect(mock.usage.map(row => row.modelKey).sort()).toEqual(['native-image', 'native-responses', 'native-responses']);
  expect(mock.performance).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'neutral', dimensions: expect.objectContaining({ operation: 'image_generation' }) }),
    expect.objectContaining({ sample: expect.objectContaining({ operation: 'chat' }) }),
  ]));
});
