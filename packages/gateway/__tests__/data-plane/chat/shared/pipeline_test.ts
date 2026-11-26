import { expect, test } from 'vitest';

import { stubChatCandidate } from './affinity/helpers.ts';
import { chatBodyEntry, chatBodyExit, chatEgressEntry, chatEgressExit, composeChat, composeChatBodies, type ChatOperation, type ChatPayload } from '../../../../src/data-plane/chat/shared/pipeline.ts';
import { createSidecarCodecFactory } from '../../../../src/data-plane/chat/shared/sidecar-codec.ts';
import { chatTargets, routeChatBody } from '../../../../src/data-plane/chat/shared/translate.ts';
import { defineOperationStage } from '../../../../src/data-plane/pipeline/facts.ts';
import type { GatewayServices } from '../../../../src/data-plane/pipeline/services.ts';
import type { HttpRequestFact, HttpResponseFact } from '@floway-dev/http';
import { run, type Facts } from '@floway-dev/pipeline';
import { parseSseResponse } from '@floway-dev/provider';

const upstreamJson = { error: { upstream: true } };
const upstreamHead: HttpResponseFact = { status: 413, statusText: '', headers: [['x-upstream', 'trace'], ['x-upstream', 'other']], body: null };
const decodeStream = async function* () { throw new Error('Unexpected successful upstream response'); };
const formatError = (_status: number | null, message: string) => ({ type: 'error', error: { type: 'api_error', message } });
const parse = {
  openaiChatCompletions: parseSseResponse('openaiChatCompletions', decodeStream, formatError),
  anthropicMessages: parseSseResponse('anthropicMessages', decodeStream, formatError),
  openaiResponses: parseSseResponse('openaiResponses', decodeStream, formatError),
  geminiGenerateContent: parseSseResponse('geminiGenerateContent', decodeStream, formatError),
};

const bodyOptions = <Op extends ChatOperation>(operation: Op, visited: ChatOperation[], observed: Facts[], body: string) => ({
  entry: chatBodyEntry(operation),
  exit: chatBodyExit(operation),
  stages: [defineOperationStage({
    name: `${operation} body fixture`,
    through: {
      request: { needs: [], provides: [], consumes: [] },
      response: { needs: [], provides: [], consumes: [] },
    },
    async execute(facts, scope) {
      visited.push(operation);
      return await scope.next(facts);
    },
  })],
  ending: routeChatBody(operation, () => { throw new Error('Unexpected translation failure'); }),
  targets: {
    ...chatTargets[operation],
    native: composeChat(`${operation} egress fixture`, {
      entry: chatEgressEntry(operation),
      exit: chatEgressExit(operation),
      stages: [
        defineOperationStage({
          name: `${operation} measurements fixture`,
          through: {
            request: { needs: [], provides: [], consumes: [] },
            response: { needs: [], provides: ['response.usage', 'response.performance'], consumes: [] },
          },
          async execute(facts, scope) {
            return {
              ...await scope.next(facts),
              'response.usage': scope.createDeferred(async () => ({ kind: 'local' })),
              'response.performance': scope.createDeferred(async () => ({ ttftMs: null })),
            };
          },
        }),
        parse[operation],
      ],
      ending: defineOperationStage({
        name: `${operation} provider fixture`,
        request: { needs: chatEgressEntry(operation) },
        return: { provides: ['response.http'] },
        async execute(facts, scope) {
          observed.push(facts);
          return {
            'response.http': {
              ...upstreamHead,
              body: scope.createStream(async function* () { yield { ok: true, value: new TextEncoder().encode(body) }; }),
            },
          };
        },
      }),
    }),
  },
});

const request = {
  method: 'POST', url: 'https://floway.example/v1/chat/completions',
  headers: [['Anthropic-Beta', 'incidental'], ['x-client', 'trace']] as [string, string][],
  body: new TextEncoder().encode('{"model":"test"}'),
};
const payload: ChatPayload<'openaiChatCompletions'> = { model: 'test', messages: [{ role: 'user', content: 'hello' }] };

const callChatBody = async (
  target: 'openaiChatCompletions' | 'anthropicMessages',
  body = JSON.stringify(upstreamJson),
  source: 'openaiChatCompletions' | 'anthropicMessages' = 'openaiChatCompletions',
) => {
  const visited: ChatOperation[] = [];
  const observed: Facts[] = [];
  const bodies = composeChatBodies({
    openaiChatCompletions: bodyOptions('openaiChatCompletions', visited, observed, body),
    anthropicMessages: bodyOptions('anthropicMessages', visited, observed, body),
    openaiResponses: bodyOptions('openaiResponses', visited, observed, body),
    geminiGenerateContent: bodyOptions('geminiGenerateContent', visited, observed, body),
  });
  const { model, upstream } = stubChatCandidate({ model: { endpoints: { [target]: {} }, limits: { max_output_tokens: 32 } } });
  const facts = {
    'request.http': request,
    'request.auth.apiKeyId': 'test-key',
    'request.auth.userId': 12,
    'request.auth.isAdmin': false,
    'request.auth.upstreamIds': null,
    'request.auth.randomizeUpstreams': false,
    'serve.runtimeLocation': 'test',
    'provider.model': model,
    'provider.upstream': upstream,
  };
  const context = {
    services: { sidecarCodec: createSidecarCodecFactory('test') } as GatewayServices,
    signal: new AbortController().signal,
    waitUntil() {},
  };
  const running = source === 'anthropicMessages'
    ? run(bodies.anthropicMessages, {
        ...facts,
        'request.anthropicMessages': { model: 'test', messages: [{ role: 'user', content: 'hello' }], max_tokens: 32 },
      }, context)
    : run(bodies.openaiChatCompletions, { ...facts, 'request.openaiChatCompletions': payload }, context);
  const answer = await running.result;
  if (answer['response.usage']) await running.read(answer['response.usage']);
  if (answer['response.performance']) await running.read(answer['response.performance']);
  await running.done;
  return { observed, visited, answer };
};

test('enters a native egress with the source payload and HTTP facts by identity', async () => {
  const { observed, visited } = await callChatBody('openaiChatCompletions');
  expect(visited).toEqual(['openaiChatCompletions']);
  expect(observed).toHaveLength(1);
  expect(observed[0]?.['request.openaiChatCompletions']).toBe(payload);
  expect(observed[0]?.['request.http']).toBe(request);
});

test('enters the translated body once and forwards its HTTP and error through the source outcome', async () => {
  const { observed, visited, answer } = await callChatBody('anthropicMessages');
  expect(visited).toEqual(['openaiChatCompletions', 'anthropicMessages']);
  expect(observed).toHaveLength(1);
  const target = observed[0]!;
  expect(target['request.anthropicMessages']).toMatchObject({ model: 'test', stream: true, messages: [{ role: 'user' }] });
  expect(Object.hasOwn(target, 'request.openaiChatCompletions')).toBe(false);
  const targetHttp = target['request.http'] as HttpRequestFact;
  expect(targetHttp.headers).toEqual([['x-client', 'trace']]);
  expect(targetHttp.body).toBe(request.body);
  expect(answer).toMatchObject({ 'response.openaiChatCompletions': { kind: 'error', source: 'upstream', error: upstreamJson } });
  expect(answer['response.http']).toEqual(upstreamHead);
  expect(Object.hasOwn(answer, 'response.anthropicMessages')).toBe(false);
});

test('translates a plain-text Messages failure into the source Chat Completions envelope', async () => {
  const message = 'upstream sent plain text instead of JSON';
  const { answer } = await callChatBody('anthropicMessages', message);
  expect(answer['response.http']).toEqual(upstreamHead);
  expect(answer).toMatchObject({ 'response.openaiChatCompletions': { kind: 'error', source: 'upstream', error: { error: { message } } } });
  expect(Object.hasOwn(answer, 'response.anthropicMessages')).toBe(false);
});

test('translates a JSON Chat Completions failure into Messages while retaining the upstream HTTP status', async () => {
  const error = { type: 'invalid_request_error', message: 'context is too large', code: 'context_length_exceeded' };
  const { answer } = await callChatBody('openaiChatCompletions', JSON.stringify({ error }), 'anthropicMessages');
  expect(answer['response.http']).toEqual(upstreamHead);
  expect(answer).toMatchObject({
    'response.anthropicMessages': { kind: 'error', source: 'upstream', error: { type: 'error', error: { message: expect.stringContaining('prompt is too long') } } },
  });
  expect(Object.hasOwn(answer, 'response.openaiChatCompletions')).toBe(false);
});
