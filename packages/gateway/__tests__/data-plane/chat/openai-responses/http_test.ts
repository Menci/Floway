import { expect, test, vi } from 'vitest';

import { http, key, providerResponses, responsesFixture, upstream } from './fixture.ts';
import { testOpenAIResponsesStatePolicy } from './test-policy.ts';
import { missingRequiredCompactionKeys, responseOnlyKeysAdded } from './test-required-resource-keys.ts';
import { syntheticEventsFromResult } from '../../../../src/data-plane/chat/openai-responses/items/output.ts';
import { createOpenAIResponsesHttpStore } from '../../../../src/data-plane/chat/openai-responses/items/store.ts';
import type { OpenResponsesStore } from '../../../../src/data-plane/pipeline/services.ts';
import { writeHttpResponse } from '../../../../src/data-plane/shared/http-writer.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { Bytes, snapshotError, type StageEnv } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesInputItem, OpenAIResponsesRequestPayloadEx, OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';
import type { ProviderResponsesInput, ProviderResponsesOutput } from '@floway-dev/provider';

const installRepo = async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  await repo.apiKeys.save({
    ...testOpenAIResponsesStatePolicy(key),
    userId: 1, name: 'Responses HTTP tests', key: 'http-fixture-key', serverSecret: '00'.repeat(32),
    createdAt: '2026-01-01T00:00:00.000Z', upstreamIds: null,
    randomizeUpstreams: false, deletedAt: null, dumpRetentionSeconds: null,
  });
  const responsesStore: OpenResponsesStore = mode => {
    if (mode.kind !== 'http') throw new Error('Expected HTTP store mode');
    return createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(key), Date.now(), mode.store);
  };
  return { repo, responsesStore };
};

const completed = (env: StageEnv): ProviderResponsesOutput => ({
  ...http(),
  'response.modelKey': 'native-responses',
  'response.result': undefined,
  'response.events': env.createStream({
    label: 'model response',
    iterate: () => syntheticEventsFromResult({
      id: 'resp_test', object: 'response', model: 'test-model', status: 'completed', error: null, incomplete_details: null,
      output: [{
        type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', annotations: [], text: 'answer' }],
      }],
    }),
  }),
});

test('Responses Lite input items keep their position and metadata across HTTP continuation', async () => {
  const { responsesStore } = await installRepo();
  const input: CanonicalOpenAIResponsesInputItem[] = [
    {
      type: 'additional_tools', role: 'developer', id: 'at_lite',
      tools: [{
        type: 'namespace', name: 'functions', description: '',
        tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
      }],
    },
    {
      type: 'message', role: 'developer', id: 'msg_base',
      content: [{ type: 'input_text', text: 'Caller base instructions' }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] },
    },
    { type: 'message', role: 'user', content: 'First turn' },
  ];
  const payloads: ProviderResponsesInput['request.payload'][] = [];
  const fixture = responsesFixture([upstream('responses', {
    openaiResponses: providerResponses((facts, env) => {
      payloads.push(facts['request.payload']);
      return completed(env);
    }),
  })], responsesStore);
  const send = async (payload: Partial<OpenAIResponsesRequestPayloadEx>) => {
    const handle = fixture.request({ model: 'test-model', store: true, ...payload }, 'generate',
      [['x-openai-internal-codex-responses-lite', 'true']]);
    const response = writeHttpResponse((await handle.result)['response.http']);
    expect(response.status).toBe(200);
    expect(await handle.done).toEqual({ ok: true });
    return await response.json() as OpenAIResponsesResultEx;
  };
  const first = await send({ input });
  await send({ previous_response_id: first.id, input: [{ role: 'user', content: 'Second turn' }] });
  expect(payloads[0]?.input).toEqual(input);
  expect(payloads[1]?.input.slice(0, input.length)).toEqual(input);
  for (const payload of payloads) {
    expect(payload.tools).toBeUndefined();
    expect(payload.instructions).toBeUndefined();
  }
});

test('POST /v1/responses streams a successful SSE body', async () => {
  const { responsesStore } = await installRepo();
  const respond = vi.fn((_facts: ProviderResponsesInput, env: StageEnv) => completed(env));
  const fixture = responsesFixture([upstream('responses', { openaiResponses: providerResponses(respond) })], responsesStore);
  const handle = fixture.request({ model: 'test-model', input: 'hello', stream: true });
  const response = writeHttpResponse((await handle.result)['response.http']);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  const body = await response.text();
  expect(body).toContain('event: response.completed');
  const completedId = body.match(/"id":"(resp_[A-Za-z0-9_-]+)"/)?.[1];
  expect(completedId).toBeDefined();
  expect(completedId).not.toBe('resp_test');
  expect(body.split('data: [DONE]')).toHaveLength(2);
  expect(body.endsWith('data: [DONE]\n\n')).toBe(true);
  expect(respond).toHaveBeenCalledTimes(1);
  expect(await handle.done).toEqual({ ok: true });
});

test('POST /v1/responses terminates an SSE stream with error when an output item cannot be persisted', async () => {
  const { repo, responsesStore } = await installRepo();
  vi.spyOn(repo.openaiResponsesItems, 'insertMany').mockRejectedValue(new Error('simulated item persistence failure'));
  const fixture = responsesFixture([upstream('responses', { openaiResponses: providerResponses((_facts, env) => completed(env)) })], responsesStore);
  const handle = fixture.request({ model: 'test-model', input: 'hello', stream: true });
  const response = writeHttpResponse((await handle.result)['response.http']);
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain('event: error');
  expect(body).toContain('simulated item persistence failure');
  expect(body).not.toContain('event: response.output_item.done');
  expect(body).not.toContain('event: response.completed');
  expect(body.endsWith('data: [DONE]\n\n')).toBe(true);
  await handle.done;
});

test('POST /v1/responses returns 502 when the response snapshot cannot be persisted', async () => {
  const { repo, responsesStore } = await installRepo();
  vi.spyOn(repo.openaiResponsesSnapshots, 'insert').mockRejectedValue(new Error('simulated snapshot persistence failure'));
  const fixture = responsesFixture([upstream('responses', { openaiResponses: providerResponses((_facts, env) => completed(env)) })], responsesStore);
  const handle = fixture.request({ model: 'test-model', input: 'hello' });
  const response = writeHttpResponse((await handle.result)['response.http']);
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ error: { message: 'simulated snapshot persistence failure' } });
  await handle.done;
});

const compactTurn = async (usage: OpenAIResponsesResultEx['usage'], requestFields: Partial<OpenAIResponsesRequestPayloadEx> = {}) => {
  const result = {
    id: 'cmp_upstream', object: 'response.compaction',
    output: [{ type: 'compaction' as const, id: 'cmp_1', encrypted_content: 'ENC' }],
    usage,
  };
  const fixture = responsesFixture([upstream('responses', {
    openaiResponses: providerResponses(facts => {
      expect(facts['request.action']).toBe('compact');
      return { ...http(), 'response.modelKey': 'native-compact', 'response.result': result, 'response.events': undefined };
    }),
  })]);
  const handle = fixture.request({ model: 'test-model', input: 'kept', store: false, ...requestFields }, 'compact');
  const response = writeHttpResponse((await handle.result)['response.http']);
  await handle.done;
  return { result, response };
};

test('POST /v1/responses/compact answers the compaction resource', async () => {
  const { result, response } = await compactTurn({ input_tokens: 12, output_tokens: 3, total_tokens: 15 }, { temperature: 0.3 });
  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, unknown>;
  expect(missingRequiredCompactionKeys(body)).toEqual([]);
  expect(typeof body.created_at).toBe('number');
  expect(body.usage).toEqual({
    input_tokens: 12, output_tokens: 3, total_tokens: 15,
    input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
  });
  expect(responseOnlyKeysAdded(result, body)).toEqual([]);
});

test('POST /v1/responses/compact reports upstream compaction without usage', async () => {
  const { response } = await compactTurn(null);
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ error: { type: 'internal_error', message: expect.stringContaining('no token usage') } });
});

test.each(['generate', 'compact'] as const)('HTTP %s uses the malformed-body envelope for interrupted uploads', async action => {
  const fixture = responsesFixture([]);
  const readFailure = snapshotError(new Error('Client disconnected during upload'));
  const malformed = fixture.requestRaw(Bytes.empty, action);
  const interrupted = fixture.requestRaw(Bytes.empty, action, undefined, readFailure);
  for (const handle of [malformed, interrupted]) {
    const response = writeHttpResponse((await handle.result)['response.http']);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: {
        type: 'internal_error', message: 'Unexpected end of JSON input',
        provider_specific_fields: { name: 'SyntaxError', stack: expect.stringContaining('JSON.parse') },
      },
    });
    expect(await handle.done).toEqual({ ok: true });
  }
  expect(fixture.requestedModels).toEqual([]);
});
