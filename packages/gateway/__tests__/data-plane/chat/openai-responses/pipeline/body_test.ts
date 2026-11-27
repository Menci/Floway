import { expect, test, vi } from 'vitest';

import type { OpenAIResponsesStatefulStore } from '../../../../../src/data-plane/chat/openai-responses/items/store.ts';
import { openAIResponsesClientOutput } from '../../../../../src/data-plane/chat/openai-responses/pipeline/client-output.ts';
import { OpenAIResponsesInterruption } from '../../../../../src/data-plane/chat/openai-responses/pipeline/interruption.ts';
import { answerOpenAIResponsesWebSocketWarmup } from '../../../../../src/data-plane/chat/openai-responses/pipeline/warmup.ts';
import { compose, defineStage } from '../../../../../src/data-plane/chat/pipeline/facts.ts';
import { createGatewayServices } from '../../../../../src/data-plane/pipeline/services.ts';
import { initRepo } from '../../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { candidateFor, hostFor } from '../../../pipeline/fixtures.ts';
import { asEntry, run, type Result } from '@floway-dev/pipeline';
import type { OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ProtocolStreamError } from '@floway-dev/upstream';

const response = (status: OpenAIResponsesResultEx['status']): OpenAIResponsesResultEx => ({
  id: 'resp_upstream',
  object: 'response',
  model: 'wire-model',
  status,
  output: [],
  error: null,
  incomplete_details: null,
  usage: null,
});

const serve = (body: (signal: AbortSignal) => AsyncGenerator<Result<OpenAIResponsesStreamEventEx, ProtocolStreamError>>) => {
  initRepo(new InMemoryRepo());
  const store = {
    apiKeyId: 'key',
    writesState: true,
    loadSnapshot: async () => null,
    loadInputItems: async () => {},
    getItemById: () => undefined,
    stageInputItems: async () => {},
    persistOutputItem: async () => {},
    commitSnapshot: vi.fn(async () => {}),
  } satisfies OpenAIResponsesStatefulStore;
  const host = hostFor(createGatewayServices({
    apiKey: { id: 'key', serverSecret: 'ab'.repeat(32), openaiResponsesRetentionSeconds: 0, upstreamIds: null, randomizeUpstreams: false },
    subject: { id: 1, isAdmin: false },
    runtimeLocation: 'TEST',
    dump: null,
    openaiResponsesStore: () => store,
  }));
  const called = vi.fn();
  const upstream = defineStage({
    name: 'script-responses-upstream',
    request: { needs: [] },
    return: { provides: ['http', 'openaiResponses'] },
    async execute(_facts, scope) {
      called();
      return { http: null, openaiResponses: { kind: 'stream', stream: scope.createStream(producer => body(producer.signal)) } };
    },
  });
  const entry = asEntry(compose('responses-body-test', {
    entry: ['openaiResponses', 'delivery', 'serve.startedAt', 'model', 'ws.message?', 'ws.responseId?'],
    exit: ['http', 'openaiResponses'],
    stages: [openAIResponsesClientOutput, answerOpenAIResponsesWebSocketWarmup],
    ending: upstream,
  }));
  const { model } = candidateFor('custom');
  return {
    host, store, called, start: (websocket: boolean, generate: boolean) => run(entry, {
      model,
      openaiResponses: { model: model.id, input: [], generate },
      delivery: { stream: true, createdAt: 123 },
      'serve.startedAt': 123_000,
      ...(websocket ? { 'ws.message': { type: 'response.create' }, 'ws.responseId': 'resp_turn' } : {}),
    }, host.options),
  };
};

test.each([true, false])('warmup uses WebSocket facts (present: %s)', async websocket => {
  const { start, host, called, store } = serve(async function* () {
    yield { ok: true, value: { type: 'response.completed', response: response('completed') } };
  });
  const execution = start(websocket, false);
  const answer = await execution.result;
  if (answer.openaiResponses.kind !== 'stream') throw new Error('Expected the Responses stream');
  const frames: OpenAIResponsesStreamEventEx[] = [];
  for await (const item of execution.read(answer.openaiResponses.stream)) {
    if (!item.ok) throw item.error.cause;
    frames.push(item.value);
  }
  host.controller.abort();
  execution.discard(answer);
  await host.settle();
  expect(host.errors).toEqual([]);
  expect(called).toHaveBeenCalledTimes(websocket ? 0 : 1);
  expect(store.commitSnapshot).toHaveBeenCalledOnce();
  expect(frames.at(-1)).toMatchObject({
    type: 'response.completed',
    response: { ...(websocket ? { id: 'resp_turn' } : {}), created_at: 123, output: [], store: true },
  });
});

test('a transport failure after response.completed prevents a successful snapshot', async () => {
  const cause = new Error('source was damaged after the terminal event');
  const observed = vi.fn();
  const { start, host, store } = serve(async function* () {
    yield { ok: true, value: { type: 'response.created', response: response('in_progress') } };
    yield { ok: true, value: { type: 'response.completed', response: response('completed') } };
    yield { ok: false, error: { kind: 'transport', cause } };
    observed();
  });
  const execution = start(false, true);
  const answer = await execution.result;
  if (answer.openaiResponses.kind !== 'stream') throw new Error('Expected the Responses stream');
  const frames = execution.read(answer.openaiResponses.stream);
  await expect(frames.next()).resolves.toMatchObject({ value: { ok: true, value: { type: 'response.created' } } });
  const failure = await frames.next();
  expect(failure.value).toEqual({ ok: false, error: { kind: 'transport', cause } });
  if (failure.done || failure.value.ok) throw new Error('Expected the late transport failure');
  expect(failure.value.error.cause).toBe(cause);
  await expect(frames.next()).resolves.toMatchObject({ done: true });
  host.controller.abort();
  execution.discard(answer);
  await host.settle();
  expect(observed).toHaveBeenCalledOnce();
  expect(store.commitSnapshot).not.toHaveBeenCalled();
  expect(host.errors).toEqual([]);
});

test('a WebSocket interruption emits the pending item and commits the incomplete snapshot', async () => {
  const { start, host, store } = serve(async function* (signal) {
    yield { ok: true, value: { type: 'response.created', sequence_number: 0, response: response('in_progress') } };
    yield {
      ok: true,
      value: {
        type: 'response.output_item.added', output_index: 0, sequence_number: 1,
        item: { type: 'message', id: 'msg_pending', role: 'assistant', status: 'in_progress', content: [] },
      },
    };
    if (!signal.aborted) {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    }
    yield { ok: false, error: { kind: 'abort', cause: new Error('source was aborted', { cause: signal.reason }) } };
  });
  const execution = start(true, true);
  const answer = await execution.result;
  if (answer.openaiResponses.kind !== 'stream') throw new Error('Expected the Responses stream');
  const frames = execution.read(answer.openaiResponses.stream);
  await expect(frames.next()).resolves.toMatchObject({ value: { ok: true, value: { type: 'response.created' } } });
  await expect(frames.next()).resolves.toMatchObject({ value: { ok: true, value: { type: 'response.output_item.added' } } });
  host.controller.abort(new OpenAIResponsesInterruption());
  await expect(frames.next()).resolves.toMatchObject({
    value: {
      ok: true, value: {
        type: 'response.output_item.interrupted', sequence_number: 2, response_id: 'resp_turn', item_id: 'msg_pending',
      },
    },
  });
  await expect(frames.next()).resolves.toMatchObject({
    value: {
      ok: true, value: {
        type: 'response.incomplete', sequence_number: 3, response: { id: 'resp_turn', incomplete_details: { reason: 'interrupted' }, output: [] },
      },
    },
  });
  await expect(frames.next()).resolves.toMatchObject({ done: true });
  execution.discard(answer);
  await host.settle();
  expect(store.commitSnapshot).toHaveBeenCalledExactlyOnceWith('resp_turn', 'append', []);
  expect(host.errors).toEqual([]);
});
