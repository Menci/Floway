import { expect, test } from 'vitest';

import { collectChat, MAX_CHAT_COLLECTION_BYTES, type ChatCollector } from '../../../../src/data-plane/chat/shared/collect.ts';
import type { ChatOutcome } from '../../../../src/data-plane/chat/shared/pipeline.ts';
import type { GatewayServices } from '../../../../src/data-plane/pipeline/services.ts';
import type { HttpResponseFact } from '@floway-dev/http';
import { factSpace, run, type Result } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { ProtocolStreamError } from '@floway-dev/provider';

type Operation = 'openaiChatCompletions';
type TestFacts = {
  'request.delivery': { stream: boolean };
  'response.openaiChatCompletions': ChatOutcome<Operation>;
  'response.http': HttpResponseFact;
};

const { compose, defineStage } = factSpace<TestFacts, GatewayServices>();
const http: HttpResponseFact = { status: 201, statusText: 'Created', headers: [['x-upstream', 'trace']], body: null };

const chunk = (content: string): OpenAIChatCompletionsStreamEvent => ({
  id: 'test', object: 'chat.completion.chunk', created: 1, model: 'test',
  choices: [{ index: 0, delta: { content }, finish_reason: null }],
});

const result = (content: string) => ({
  kind: 'result' as const,
  result: {
    id: 'test', object: 'chat.completion' as const, created: 1, model: 'test',
    choices: [{ index: 0, message: { role: 'assistant' as const, content, refusal: null }, finish_reason: 'stop' as const, logprobs: null }],
  },
});

const collect = (
  source: () => AsyncGenerator<Result<OpenAIChatCompletionsStreamEvent, ProtocolStreamError>>,
  collector: ChatCollector<Operation>,
) => run(compose('chat collection test', {
  entry: ['request.delivery'],
  exit: ['response.http', 'response.openaiChatCompletions'],
  stages: [collectChat('openaiChatCompletions', () => collector, error => ({
    kind: 'error', source: error.kind === 'abort' ? 'local' : 'upstream', error: error.cause, status: 502,
  }))],
  ending: defineStage({
    name: 'chat upstream fixture',
    request: { needs: [] },
    return: { provides: ['response.http', 'response.openaiChatCompletions'] },
    async execute(_facts, scope) {
      return { 'response.http': http, 'response.openaiChatCompletions': { kind: 'stream', stream: scope.createStream(source) } };
    },
  }),
}), {
  'request.delivery': { stream: false },
}, { services: {} as GatewayServices, signal: new AbortController().signal, waitUntil() {} });

test('folds each chat frame before pulling the next and returns a scalar result', async () => {
  let text = '';
  const running = collect(async function* () {
    yield { ok: true, value: chunk('a') };
    expect(text).toBe('a');
    yield { ok: true, value: chunk('b') };
    expect(text).toBe('ab');
  }, {
    push(event) { text += event.choices[0]!.delta.content; },
    finish: () => result(text),
  });

  await expect(running.result).resolves.toEqual({ 'response.http': http, 'response.openaiChatCompletions': result('ab') });
  await running.done;
});

test('returns the decoded in-stream transport failure and preserves headers', async () => {
  const cause = new Error('socket dropped');
  const running = collect(async function* () {
    yield { ok: false, error: { kind: 'transport', cause } };
  }, {
    push() { throw new Error('Unexpected successful frame'); },
    finish() { throw new Error('Unexpected successful completion'); },
  });

  const answer = await running.result;
  expect(answer['response.http']).toEqual({ status: 502, headers: http.headers, statusText: '', body: null });
  expect(answer['response.openaiChatCompletions']).toEqual({ kind: 'error', source: 'upstream', error: cause });
  await running.done;
});

test('panics on cumulative overflow before giving the oversized frame to the collector', async () => {
  const event = chunk('x'.repeat(1024 * 1024));
  let frames = 0;
  const running = collect(async function* () {
    for (let index = 0; index < MAX_CHAT_COLLECTION_BYTES / (1024 * 1024); index++) yield { ok: true, value: event };
  }, {
    push() { frames++; },
    finish() { throw new Error('Unexpected successful completion'); },
  });
  const message = 'byte collection limit';
  await expect(running.result).rejects.toThrow(message);
  await expect(running.done).rejects.toThrow(message);
  expect(frames).toBe(63);
});
