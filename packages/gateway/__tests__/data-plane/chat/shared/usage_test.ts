import { expect, test, vi } from 'vitest';

import { stubChatCandidate } from './affinity/helpers.ts';
import { openAIChatCompletionsChat } from '../../../../src/data-plane/chat/openai-chat-completions/pipeline-stages.ts';
import { chatBodies } from '../../../../src/data-plane/chat/pipeline.ts';
import { chatTokenUsage } from '../../../../src/data-plane/chat/shared/usage.ts';
import { createGatewayServices } from '../../../../src/data-plane/pipeline/services.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { run } from '@floway-dev/pipeline';
import type { BillableUsage } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

type Event = { final?: boolean; usage: BillableUsage | null };

const counts = (input: number, output: number): BillableUsage => ({ input, output, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
const read = () => (event: Event) => event.usage;
const transportFailure = { kind: 'transport' as const, cause: new Error('socket dropped') };

test('preserves partial usage on failure and publishes the final snapshot when it arrives', () => {
  const createReader = chatTokenUsage(read, event => event.final === true);
  const failed = createReader();
  expect(failed.frame({ usage: counts(5, 0) })).toBeUndefined();
  expect(failed.error?.(transportFailure)).toMatchObject([{ dumpTokenUsage: { input: 5 } }]);

  const completed = createReader();
  expect(completed.frame({ usage: counts(5, 0) })).toBeUndefined();
  const usage = completed.frame({ final: true, usage: counts(5, 8) });
  expect(usage).toMatchObject([{ dumpTokenUsage: { input: 5, output: 8 } }]);
  expect(completed.done()).toBe(usage);
});

test('reads an authoritative usage snapshot from a native error event', () => {
  const reader = chatTokenUsage(read, event => event.final === true)();
  const usage = counts(5, 6);
  expect(reader.error?.({
    kind: 'protocol',
    cause: new Error('response failed'),
    event: { final: true, usage: { ...usage } },
  })).toMatchObject([{ dumpTokenUsage: { input: 5, output: 6 } }]);
});

test('distinguishes upstream zero from a completed call without a usage report', () => {
  const createReader = chatTokenUsage(read);
  const omitted = createReader();
  expect(omitted.frame({ usage: null })).toBeUndefined();
  expect(omitted.error?.(transportFailure)).toBeUndefined();
  expect(omitted.done()).toMatchObject([{ quantities: {}, dumpTokenUsage: null }]);

  const reported = createReader();
  expect(reported.frame({ usage: counts(0, 0) })).toMatchObject([{ quantities: {}, dumpTokenUsage: {} }]);
});

test('only publishes Chat Completions totals early on an actual usage-only tail', () => {
  const reader = openAIChatCompletionsChat.usage();
  const frame: OpenAIChatCompletionsStreamEvent = {
    id: 'chat-test', model: 'test', object: 'chat.completion.chunk', created: 1,
    choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
    usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
  };
  expect(reader.frame(frame)).toBeUndefined();
  expect(reader.frame({ ...frame, choices: [], usage: null })).toBeUndefined();
  const observed = reader.frame({ ...frame, choices: [], usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 } });
  expect(observed).toMatchObject([{ dumpTokenUsage: { input: 5, output: 8 } }]);
});

const usageFrame = (outputTokens: number, done = false): OpenAIChatCompletionsStreamEvent => ({
  id: 'chat-test', model: 'test', object: 'chat.completion.chunk', created: 1,
  choices: done ? [] : [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
  usage: { prompt_tokens: 5, completion_tokens: outputTokens, total_tokens: 5 + outputTokens },
});

test.each(['tail', 'eof', 'error'] as const)('stores the latest Chat Completions usage through the composed body on %s', async mode => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const { model, upstream } = stubChatCandidate({
    model: { endpoints: { openaiChatCompletions: {} } },
    upstream: { config: { baseUrl: 'https://upstream.test', ingressHeadersRules: [] } },
  });
  const services = await createGatewayServices('test', { id: 'chat-key', serverSecret: '12'.repeat(32), openaiResponsesRetentionSeconds: 0 }, []);
  const detached: Promise<unknown>[] = [];
  let upstreamBody!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { upstreamBody = controller; } }, { highWaterMark: 0 });
  const send = (payload: unknown): void => upstreamBody.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
  const running = run(chatBodies.openaiChatCompletions, {
    'request.http': { url: 'https://floway.test/v1/chat/completions', method: 'POST', headers: [], body: null },
    'request.openaiChatCompletions': { model: 'test', messages: [{ role: 'user', content: 'hi' }] },
    'request.auth.apiKeyId': 'chat-key',
    'request.auth.userId': 1,
    'request.auth.isAdmin': true,
    'request.auth.upstreamIds': null,
    'request.auth.randomizeUpstreams': false,
    'serve.runtimeLocation': 'test',
    'provider.model': model,
    'provider.upstream': upstream,
  }, {
    services: { ...services, fetcher: () => async () => ({ response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }) }) },
    signal: new AbortController().signal,
    waitUntil: work => { detached.push(work); },
  });
  const answer = await running.result;
  const outcome = answer['response.openaiChatCompletions'];
  if (outcome.kind !== 'stream') throw new Error('Expected the upstream chat stream');
  if (answer['response.usage'] === undefined || answer['response.performance'] === undefined) throw new Error('Expected native chat measurements');
  const cursor = running.read(outcome.stream);
  const usage = running.read(answer['response.usage']);
  const performance = running.read(answer['response.performance']);
  const storedTotals = [{ requests: 1, metrics: expect.arrayContaining([{ metric: 'output_tokens', quantity: '200', unitPrice: null }]) }];

  try {
    send(usageFrame(1));
    expect(await cursor.next()).toMatchObject({ done: false, value: { ok: true, value: { choices: expect.any(Array) } } });
    expect(await cursor.next()).toMatchObject({ done: false, value: { ok: true, value: { choices: [], usage: { completion_tokens: 1 } } } });

    send(usageFrame(200, mode === 'tail'));
    if (mode !== 'tail') expect((await cursor.next()).done).toBe(false);
    expect(await cursor.next()).toMatchObject({ done: false, value: { ok: true, value: { choices: [], usage: { completion_tokens: 200 } } } });

    if (mode === 'tail') {
      await vi.waitFor(async () => expect(await repo.usage.listAll()).toMatchObject(storedTotals));
      expect(await repo.performance.listAll()).toEqual([]);
    } else {
      expect(await repo.usage.listAll()).toEqual([]);
      if (mode === 'error') send({ error: { type: 'server_error', message: 'dial failed after the usage snapshot' } });
    }
  } finally {
    upstreamBody.close();
  }

  if (mode === 'error') expect(await cursor.next()).toMatchObject({ done: false, value: { ok: false, error: { kind: 'protocol' } } });
  expect((await cursor.next()).done).toBe(true);
  await expect(usage).resolves.toMatchObject({ kind: 'observed', usage: [{ dumpTokenUsage: { input: 5, output: 200 } }] });
  await performance;
  await running.done;
  await Promise.all(detached);
  expect(await repo.usage.listAll()).toMatchObject(storedTotals);
});
