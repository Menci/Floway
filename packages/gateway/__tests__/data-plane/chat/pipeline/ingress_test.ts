import { expect, test } from 'vitest';

import { encodeAnthropicMessages } from '../../../../src/data-plane/chat/anthropic-messages/pipeline/encode.ts';
import { parseAnthropicMessages } from '../../../../src/data-plane/chat/anthropic-messages/pipeline/parse.ts';
import { encodeGeminiGenerateContent } from '../../../../src/data-plane/chat/gemini-generate-content/pipeline/encode.ts';
import { parseGeminiGenerateContent } from '../../../../src/data-plane/chat/gemini-generate-content/pipeline/parse.ts';
import { collectOpenAIChatCompletions } from '../../../../src/data-plane/chat/openai-chat-completions/pipeline/collect.ts';
import { encodeOpenAIChatCompletions } from '../../../../src/data-plane/chat/openai-chat-completions/pipeline/encode.ts';
import { parseOpenAIChatCompletions } from '../../../../src/data-plane/chat/openai-chat-completions/pipeline/parse.ts';
import { encodeOpenAIResponsesWebSocket } from '../../../../src/data-plane/chat/openai-responses/pipeline/encode-websocket.ts';
import { encodeOpenAIResponses } from '../../../../src/data-plane/chat/openai-responses/pipeline/encode.ts';
import { parseOpenAIResponsesWebSocket } from '../../../../src/data-plane/chat/openai-responses/pipeline/parse-websocket.ts';
import { parseOpenAIResponses } from '../../../../src/data-plane/chat/openai-responses/pipeline/parse.ts';
import { localChatHead } from '../../../../src/data-plane/chat/pipeline/encode.ts';
import type { ChatRequestFacts, ChatResponseFacts } from '../../../../src/data-plane/chat/pipeline/facts.ts';
import type { GatewayDump, GatewayServices } from '../../../../src/data-plane/pipeline/services.ts';
import { hostFor } from '../../pipeline/fixtures.ts';
import { getHeader, getHeaders, type HttpRequestFact } from '@floway-dev/http';
import { asEntry, factSpace, run } from '@floway-dev/pipeline';
import { PROMPT_TOO_LONG_MESSAGE } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ProtocolStreamError } from '@floway-dev/upstream';

const { defineStage, compose } = factSpace<ChatRequestFacts, ChatResponseFacts, Pick<GatewayServices, 'dump'>>();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const dumpFor = (firstOutput: number[], frames: ProtocolFrame<unknown>[] = []): GatewayDump => ({
  requestedModel() {}, setUpstreamTargetApi() {}, upstreamFrame() {}, upstreamApiError() {},
  stageUpstreamTranslationError() {}, selectUpstreamTranslationError() {}, error() {}, failed() {}, success() {},
  frame: frame => { frames.push(frame); },
  firstOutput: startedAt => { firstOutput.push(startedAt); },
});

const request = (path: string, value: unknown): HttpRequestFact => ({
  url: `https://floway.invalid${path}`,
  method: 'POST',
  headers: [['x-custom', 'first'], ['x-custom', 'second']],
  body: encoder.encode(JSON.stringify(value)),
});

const text = (body: unknown): string => {
  if (!(body instanceof Uint8Array)) throw new TypeError('Expected buffered bytes');
  return decoder.decode(body);
};

const chunk: OpenAIChatCompletionsStreamEvent = {
  id: 'chunk', object: 'chat.completion.chunk', model: 'example-model', created: 1,
  choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
};

const chatCompletionsEntry = (failure?: ProtocolStreamError, wait?: Promise<void>, chunks = [chunk]) => {
  const ending = defineStage({
    name: 'chat-completions-test-provider',
    request: { needs: ['http', 'openaiChatCompletions', 'delivery', 'requestedModel'] },
    return: { provides: ['http', 'openaiChatCompletions'] },
    async execute(facts, scope) {
      expect(facts.requestedModel).toBe('example-model');
      expect(facts.http.body).toBeInstanceOf(Uint8Array);
      expect(getHeaders(facts.http.headers, 'x-custom')).toEqual(['first', 'second']);
      const stream = scope.createStream<OpenAIChatCompletionsStreamEvent, ProtocolStreamError>(async function* () {
        for (const value of chunks) yield { ok: true, value };
        if (failure !== undefined) yield { ok: false, error: failure };
        await wait;
      });
      const http = { ...localChatHead(201), startedAt: 42, headers: [['X-Trace', 'first'], ['X-Trace', 'second']] as [string, string][] };
      return { http, openaiChatCompletions: { kind: 'stream', stream } };
    },
  });
  return asEntry(compose('chat-completions-test', {
    entry: ['http'], exit: ['http'],
    stages: [parseOpenAIChatCompletions, encodeOpenAIChatCompletions, collectOpenAIChatCompletions], ending,
  }));
};

test('encodes a normal Chat Completions EOF with no upstream done marker or finish reason', async () => {
  const wait = Promise.withResolvers<void>();
  const firstOutput: number[] = [];
  const host = hostFor({ dump: dumpFor(firstOutput) });
  const preamble: OpenAIChatCompletionsStreamEvent = { ...chunk, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] };
  const running = run(chatCompletionsEntry(undefined, wait.promise, [preamble, chunk]), {
    http: request('/v1/chat/completions', { model: 'example-model', messages: [], stream: true, n: 2 }),
  }, host.options);
  const answer = await running.result;
  const { http } = answer;
  if (http?.body == null || http.body instanceof Uint8Array) throw new Error('Expected encoded SSE');
  expect(http.status).toBe(201);
  expect(getHeaders(http.headers, 'x-trace')).toEqual(['first', 'second']);
  const cursor = running.read(http.body);
  expect(text((await cursor.next()).value.value)).toContain('assistant');
  expect(firstOutput).toEqual([]);
  expect(text((await cursor.next()).value.value)).toContain('hello');
  expect(firstOutput).toEqual([42]);
  const terminal = cursor.next();
  wait.resolve();
  expect(text((await terminal).value.value)).toBe('data: [DONE]\n\n');
  expect((await cursor.next()).done).toBe(true);
  expect(firstOutput).toEqual([42]);
  host.controller.abort();
  running.discard(answer);
  await host.settle();
});

test('renders a broken Chat Completions stream and relinquishes its still-open remainder', async () => {
  const wait = Promise.withResolvers<void>();
  const cause = new Error('broken socket');
  const host = hostFor({ dump: null });
  const running = run(chatCompletionsEntry({ kind: 'transport', cause }, wait.promise), {
    http: request('/v1/chat/completions', { model: 'example-model', messages: [], stream: true }),
  }, host.options);
  const answer = await running.result;
  const { http } = answer;
  if (http?.body == null || http.body instanceof Uint8Array) throw new Error('Expected encoded SSE');
  const cursor = running.read(http.body);
  expect(text((await cursor.next()).value.value)).toContain('hello');
  const error = text((await cursor.next()).value.value);
  expect(error).toContain('broken socket');
  expect(error).toContain('provider_specific_fields');
  expect((await cursor.next()).done).toBe(true);
  host.controller.abort();
  running.discard(answer);
  wait.resolve();
  await host.settle();
});

test('collects Chat Completions incrementally to the same result arm before encoding JSON', async () => {
  const firstOutput: number[] = [];
  const frames: ProtocolFrame<unknown>[] = [];
  const host = hostFor({ dump: dumpFor(firstOutput, frames) });
  const running = run(chatCompletionsEntry(), {
    http: request('/v1/chat/completions', { model: 'example-model', messages: [] }),
  }, host.options);
  const answer = await running.result;
  expect(JSON.parse(text(answer.http?.body))).toMatchObject({
    id: 'chunk', object: 'chat.completion', choices: [{ message: { content: 'hello' } }],
  });
  expect(firstOutput).toEqual([]);
  expect(frames).toEqual([{ type: 'event', event: chunk }]);
  host.controller.abort();
  running.discard(answer);
  await host.settle();
});

test('preserves the rewritten Anthropic prompt-too-long status and diagnostic headers', async () => {
  const ending = defineStage({
    name: 'anthropic-messages-test-provider',
    request: { needs: ['anthropicMessages'] }, return: { provides: ['http', 'anthropicMessages'] },
    async execute() {
      return {
        http: { ...localChatHead(400), headers: [['server-trace', 'trace-id'], ['content-type', 'application/problem+json; charset=utf-8']] },
        anthropicMessages: {
          kind: 'error', source: 'upstream',
          error: { type: 'error', error: { type: 'invalid_request_error', message: PROMPT_TOO_LONG_MESSAGE } },
        },
      };
    },
  });
  const entry = asEntry(compose('anthropic-messages-test', {
    entry: ['http'], exit: ['http'], stages: [parseAnthropicMessages, encodeAnthropicMessages], ending,
  }));
  const host = hostFor({ dump: null });
  const running = run(entry, { http: request('/v1/messages', { model: 'example-model', messages: [], max_tokens: 10 }) }, host.options);
  const answer = await running.result;
  expect(answer.http?.status).toBe(400);
  expect(answer.http?.headers).toContainEqual(['server-trace', 'trace-id']);
  expect(getHeader(answer.http?.headers ?? [], 'content-type')).toBe('application/problem+json; charset=utf-8');
  expect(JSON.parse(text(answer.http?.body))).toMatchObject({ error: { message: PROMPT_TOO_LONG_MESSAGE } });
  host.controller.abort();
  running.discard(answer);
  await host.settle();
});

test.each([
  { status: 501, source: 'upstream', error: 'vendor error string', expectedStatus: 501, expected: 'vendor error string' },
  {
    status: 502, source: 'local', error: { error: { code: 502, message: 'gateway debug', status: 'INTERNAL' } },
    expectedStatus: 500, expected: { error: { code: 500, message: 'gateway debug', status: 'INTERNAL' } },
  },
] as const)('renders Gemini $source errors with status $expectedStatus', async ({ status, source, error, expectedStatus, expected }) => {
  const ending = defineStage({
    name: 'gemini-test-provider',
    request: { needs: ['geminiGenerateContent', 'requestedModel', 'delivery'] }, return: { provides: ['http', 'geminiGenerateContent'] },
    async execute(facts) {
      expect(facts.requestedModel).toBe('gemini-test');
      expect(facts.delivery.stream).toBe(true);
      return { http: localChatHead(status), geminiGenerateContent: { kind: 'error', source, error } };
    },
  });
  const entry = asEntry(compose('gemini-test', {
    entry: ['http'], exit: ['http'], stages: [parseGeminiGenerateContent, encodeGeminiGenerateContent], ending,
  }));
  const host = hostFor({ dump: null });
  const running = run(entry, { http: request('/v1beta/models/models%2Fgemini-test:streamGenerateContent', { contents: [] }) }, host.options);
  const answer = await running.result;
  expect(answer.http?.status).toBe(expectedStatus);
  expect(JSON.parse(text(answer.http?.body))).toEqual(expected);
  host.controller.abort();
  running.discard(answer);
  await host.settle();
});

test('retains the original Responses store preference on a WebSocket warmup', async () => {
  const ending = defineStage({
    name: 'responses-websocket-test-body',
    request: { needs: ['openaiResponses', 'delivery', 'ws.responseId?'] },
    return: { provides: ['http', 'openaiResponses'] },
    async execute(facts, scope) {
      expect(facts['ws.responseId']).toBe('gateway-turn-id');
      expect(facts.openaiResponses).toMatchObject({ generate: false, stream: true });
      expect(facts.delivery).toEqual({ stream: true, createdAt: 12, store: false });
      return {
        http: null,
        openaiResponses: { kind: 'stream', stream: scope.createStream(async function* () {}) },
      };
    },
  });
  const entry = asEntry(compose('responses-websocket-test', {
    entry: ['ws.message', 'ws.responseId?', 'serve.startedAt'], exit: ['http', 'openaiResponses'],
    stages: [parseOpenAIResponsesWebSocket, encodeOpenAIResponsesWebSocket], ending,
  }));
  const host = hostFor({ dump: null });
  const running = run(entry, {
    'ws.message': { type: 'response.create', response: { model: 'example-model', input: [], store: false, generate: false } },
    'ws.responseId': 'gateway-turn-id',
    'serve.startedAt': 12_345,
  }, host.options);
  const answer = await running.result;
  if (answer.openaiResponses.kind !== 'stream') throw new TypeError('Expected a Responses stream');
  expect((await running.read(answer.openaiResponses.stream).next()).done).toBe(true);
  host.controller.abort();
  running.discard(answer);
  await host.settle();
});

test('encodes the Responses terminal only after the selected stream reaches native done', async () => {
  const resume = Promise.withResolvers<void>();
  const reachedEnd = Promise.withResolvers<void>();
  const response: OpenAIResponsesResultEx = {
    id: 'rsp_selected', object: 'response', model: 'example-model', status: 'completed',
    output: [], error: null, incomplete_details: null, usage: null,
  };
  const ending = defineStage({
    name: 'responses-test-provider',
    request: { needs: ['openaiResponses'] }, return: { provides: ['http', 'openaiResponses'] },
    async execute(_facts, scope) {
      const stream = scope.createStream<OpenAIResponsesStreamEventEx, ProtocolStreamError>(async function* () {
        yield { ok: true, value: { type: 'response.created', response: { ...response, status: 'in_progress' } } };
        yield { ok: true, value: { type: 'response.completed', response } };
        reachedEnd.resolve();
        await resume.promise;
      });
      return { http: localChatHead(200), openaiResponses: { kind: 'stream', stream } };
    },
  });
  const entry = asEntry(compose('responses-sse-test', {
    entry: ['http', 'serve.startedAt'], exit: ['http'], stages: [parseOpenAIResponses, encodeOpenAIResponses], ending,
  }));
  const host = hostFor({ dump: null });
  const running = run(entry, {
    http: request('/v1/responses', { model: 'example-model', input: [], stream: true }),
    'serve.startedAt': 12_345,
  }, host.options);
  const answer = await running.result;
  if (answer.http?.body == null || answer.http.body instanceof Uint8Array) throw new TypeError('Expected encoded Responses SSE');
  expect(getHeader(answer.http.headers, 'x-reasoning-included')).toBe('true');
  const cursor = running.read(answer.http.body);
  expect(text((await cursor.next()).value.value)).toContain('event: response.created');
  let terminalDelivered = false;
  const terminal = cursor.next().then(item => {
    terminalDelivered = true;
    return item;
  });
  await reachedEnd.promise;
  expect(terminalDelivered).toBe(false);
  resume.resolve();
  expect(text((await terminal).value.value)).toContain('event: response.completed');
  expect(text((await cursor.next()).value.value)).toBe('data: [DONE]\n\n');
  expect((await cursor.next()).done).toBe(true);
  host.controller.abort();
  running.discard(answer);
  await host.settle();
});
