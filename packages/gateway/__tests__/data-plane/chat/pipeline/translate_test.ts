import { expect, test } from 'vitest';

import { chatBodyEntry, chatBodyExit, chatBodyTargets } from '../../../../src/data-plane/chat/pipeline/topology.ts';
import { translateChat } from '../../../../src/data-plane/chat/pipeline/translate.ts';
import { gatewayFactSpace, type ServeCandidate } from '../../../../src/data-plane/pipeline/facts.ts';
import { responseHead } from '../../../../src/data-plane/pipeline/response.ts';
import { createGatewayServices, type GatewayServices } from '../../../../src/data-plane/pipeline/services.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { getHeader, getHeaders, type HttpRequestFact } from '@floway-dev/http';
import { move, run, type Result } from '@floway-dev/pipeline';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import { formatOpenAIChatCompletionsError, type OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import type { ProtocolStreamError } from '@floway-dev/provider';
import { routeOpenAIChatCompletionsViaAnthropicMessages, routeOpenAIChatCompletionsViaOpenAIResponses } from '@floway-dev/translate';

const source = 'openaiChatCompletions';
const target = 'anthropicMessages';
const { compose, defineStage } = gatewayFactSpace<GatewayServices>();

const candidate: ServeCandidate = {
  upstream: { id: 'translated-upstream', kind: 'custom', name: 'Translated Upstream', config: {} },
  model: {
    id: 'translated-model',
    kind: 'chat',
    upstreamModelId: 'native-model',
    limits: { max_output_tokens: 10 },
    endpoints: { anthropicMessages: {}, openaiResponses: {} },
    opaqueBlobCompatibilityScope: { bindToUpstream: false },
    enabledFlags: [],
  },
};

const facts = {
  'request.http': move<HttpRequestFact>({
    url: 'http://localhost/v1/chat/completions', method: 'POST', body: null,
    headers: [['anthropic-beta', 'client-beta'], ['x-trace-id', 'preserved']],
  }),
  'request.auth.apiKeyId': 'test-key',
  'request.auth.user': move({ id: 1, isAdmin: false }),
  'request.auth.upstreamIds': move(['translated-upstream']),
  'request.auth.randomizeUpstreams': false,
  'serve.candidate': move(candidate),
  'request.openaiChatCompletions': move<OpenAIChatCompletionsPayloadEx>({
    model: 'client-model',
    stream: false,
    messages: [{ role: 'user', content: 'hello' }],
  }),
};

const services = (): GatewayServices => {
  initRepo(new InMemoryRepo());
  return createGatewayServices({ requestBody: null, runtimeLocation: 'test', serverSecret: '00'.repeat(32) });
};

const sourceBody = (
  egress: ReturnType<typeof defineStage>,
  translator = routeOpenAIChatCompletionsViaAnthropicMessages,
) => {
  const targetEgress = compose('test.anthropicMessages.egress', {
    entry: chatBodyEntry(target), exit: chatBodyExit(target), stages: [], ending: egress,
  });
  const targetBody = compose('test.anthropicMessages.body', {
    entry: chatBodyEntry(target), exit: chatBodyExit(target), stages: [], ...chatBodyTargets(target, targetEgress, []),
  });
  const translated = translateChat(source, target, translator, () => targetBody, ({ type: _type, message, ...fields }) =>
    formatOpenAIChatCompletionsError(400, message, { type: 'invalid_request_error', ...fields }));
  const nativeEnding = defineStage({
    name: 'test.unused-native-openai-chat-completions',
    request: { needs: chatBodyEntry(source) },
    return: { provides: chatBodyExit(source) },
    async execute() { throw new Error('Selected the wrong native endpoint'); },
  });
  const unused = compose('test.openaiChatCompletions.egress', {
    entry: chatBodyEntry(source), exit: chatBodyExit(source), stages: [], ending: nativeEnding,
  });
  const bodyTargets = chatBodyTargets(source, unused, [
    [target, () => translated],
    ['openaiResponses', () => unused],
  ]);
  return compose('test.openaiChatCompletions.body', {
    entry: chatBodyEntry(source), exit: chatBodyExit(source), stages: [], ...bodyTargets,
  });
};

test('translation selects the preferred available target, preserves its trip and drains after abort', async () => {
  const aborted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let drained = false;
  const targetEgress = defineStage({
    name: 'test.anthropic-messages-stream',
    request: { needs: chatBodyEntry(target) },
    return: { provides: chatBodyExit(target) },
    async execute(request, scope) {
      expect(Object.hasOwn(request, 'request.openaiChatCompletions')).toBe(false);
      expect(request['request.auth.user']).toEqual({ id: 1, isAdmin: false });
      expect(request['request.auth.upstreamIds']).toEqual(['translated-upstream']);
      expect(request['request.auth.randomizeUpstreams']).toBe(false);
      expect(request['request.http'].headers).toEqual([['x-trace-id', 'preserved']]);
      expect(request['request.anthropicMessages']).toMatchObject({ model: candidate.model.id, stream: true, max_tokens: 10 });
      const stream = scope.createStream(async function* ({ signal }): AsyncIterable<Result<AnthropicMessagesStreamEventEx, ProtocolStreamError>> {
        yield { ok: true, value: { type: 'message_stop' } };
        expect(signal.aborted).toBe(true);
        aborted.resolve();
        await release.promise;
        drained = true;
      });
      return {
        'response.http': move(responseHead(200)),
        'response.anthropicMessages': move({ kind: 'stream', stream } as const),
      };
    },
  });
  const pipeline = sourceBody(targetEgress, async (payload, options) => {
    expect(payload.stream).toBe(true);
    const message = payload.messages[0];
    if (message?.role !== 'user' || typeof message.content !== 'string') throw new TypeError('Expected source text');
    const { content } = message;
    const trip = await routeOpenAIChatCompletionsViaAnthropicMessages(payload, options);
    if (trip.type === 'input-error') return trip;
    return {
      ...trip,
      async *events(frames) {
        for await (const frame of frames) {
          expect(frame).toEqual({ type: 'event', event: { type: 'message_stop' } });
          yield eventFrame({
            id: 'chatcmpl-translated',
            object: 'chat.completion.chunk',
            created: 1,
            model: payload.model,
            choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }],
          });
          yield doneFrame();
        }
      },
    };
  });
  const handle = run(pipeline, facts, { services: services() });
  const answer = await handle.result;
  expect(Object.hasOwn(answer, 'response.anthropicMessages')).toBe(false);
  const outcome = answer['response.openaiChatCompletions'];
  if (outcome.kind !== 'stream') throw new TypeError('Expected the translated stream');
  const reader = outcome.stream[Symbol.asyncIterator]();
  expect((await reader.next()).value).toMatchObject({ ok: true, value: { model: candidate.model.id, choices: [{ delta: { content: 'hello' } }] } });
  let finished = false;
  const end = reader.next().then(item => {
    finished = true;
    return item;
  });
  try {
    await Promise.race([aborted.promise, end.then(() => { throw new Error('Translation ended before aborting target'); })]);
    expect(finished).toBe(false);
    expect(drained).toBe(false);
  } finally {
    release.resolve();
  }
  expect((await end).done).toBe(true);
  await handle.done;
  expect(drained).toBe(true);
});

test('translation restates the target failure and retains its origin, status and repeated headers', async () => {
  const targetEgress = defineStage({
    name: 'test.anthropic-messages-failure',
    request: { needs: chatBodyEntry(target) },
    return: { provides: chatBodyExit(target) },
    async execute() {
      return {
        'response.http': move({
          ...responseHead(429),
          headers: [['x-diagnostic', 'a'], ['x-diagnostic', 'b'], ['content-type', 'text/plain'], ['content-length', '10']] as const,
        }),
        'response.anthropicMessages': move({
          kind: 'error',
          source: 'upstream',
          error: { type: 'error', error: { type: 'rate_limit_error', message: 'Please retry.' } },
          cause: 'target diagnostic',
        } as const),
      };
    },
  });
  const handle = run(sourceBody(targetEgress), facts, { services: services() });
  const answer = await handle.result;
  expect(answer['response.openaiChatCompletions']).toMatchObject({
    kind: 'error', source: 'upstream', cause: 'target diagnostic', error: { error: { message: 'Please retry.' } },
  });
  expect(Object.hasOwn(answer, 'response.anthropicMessages')).toBe(false);
  const http = answer['response.http']!;
  expect(http.status).toBe(429);
  expect(getHeaders(http.headers, 'x-diagnostic')).toEqual(['a', 'b']);
  expect(getHeader(http.headers, 'content-type')).toBe('application/json');
  expect(getHeader(http.headers, 'content-length')).toBeUndefined();
  await handle.done;
});

test('translation rejects invalid source input before entering the target pipeline', async () => {
  const targetEgress = defineStage({
    name: 'test.unused-anthropic-messages',
    request: { needs: chatBodyEntry(target) },
    return: { provides: chatBodyExit(target) },
    async execute() { throw new Error('Target pipeline must not start for invalid source input'); },
  });
  const pipeline = sourceBody(targetEgress, async () => ({
    type: 'input-error', param: 'messages', message: 'Invalid message.',
  }));
  const handle = run(pipeline, facts, { services: services() });
  const answer = await handle.result;
  expect(answer['response.http']?.status).toBe(400);
  expect(answer['response.openaiChatCompletions']).toMatchObject({
    kind: 'error', source: 'local', error: { error: { message: 'Invalid message.', param: 'messages' } },
  });
  await handle.done;
});

test('translation into OpenAI Responses enters the generate action', async () => {
  const responses = 'openaiResponses';
  const entry = [...chatBodyEntry(responses), 'request.openaiResponsesAction'] as const;
  const exit = chatBodyExit(responses);
  const ending = defineStage({
    name: 'test.openai-responses-action',
    request: { needs: entry },
    return: { provides: exit },
    async execute(request) {
      expect(request['request.openaiResponsesAction']).toBe('generate');
      expect(request['request.http']).toBe(facts['request.http']);
      expect(request['request.openaiResponses'].model).toBe(candidate.model.id);
      return {
        'response.http': move(responseHead(429)),
        'response.openaiResponses': move({ kind: 'error', source: 'upstream', error: { message: 'Please retry.' } } as const),
      };
    },
  });
  const body = compose('test.openaiResponses.body', { entry, exit, stages: [], ending });
  const translation = translateChat(source, responses, routeOpenAIChatCompletionsViaOpenAIResponses, () => body, error => error);
  const handle = run(translation, facts, { services: services() });
  expect((await handle.result)['response.http']?.status).toBe(429);
  await handle.done;
});
