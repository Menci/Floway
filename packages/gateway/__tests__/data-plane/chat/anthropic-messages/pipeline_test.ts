import { expect, test } from 'vitest';

import { collectAnthropicMessages, collectAnthropicMessagesStreamError, encodeAnthropicMessages } from '../../../../src/data-plane/chat/anthropic-messages/encode.ts';
import { answerClaudeCodeProbe } from '../../../../src/data-plane/chat/anthropic-messages/interceptors/answer-claude-code-probe.ts';
import { stripBillingAttribution } from '../../../../src/data-plane/chat/anthropic-messages/interceptors/strip-billing-attribution.ts';
import { parseAnthropicMessages } from '../../../../src/data-plane/chat/anthropic-messages/parse.ts';
import { anthropicMessagesIngress } from '../../../../src/data-plane/chat/pipeline.ts';
import { collectChat } from '../../../../src/data-plane/chat/shared/collect.ts';
import { localResponseHead } from '../../../../src/data-plane/pipeline/encode.ts';
import { compose, defineStage, type GatewayPipelineFacts } from '../../../../src/data-plane/pipeline/facts.ts';
import { createGatewayServices, type GatewayServices } from '../../../../src/data-plane/pipeline/services.ts';
import { createProvider } from '../../../../src/data-plane/providers/registry.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import type { StoredUpstreamRecord } from '../../../../src/repo/types.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { stubChatCandidate } from '../shared/affinity/helpers.ts';
import { UpstreamTransportError } from '@floway-dev/http';
import { run } from '@floway-dev/pipeline';
import { createAnthropicMessagesUsage } from '@floway-dev/protocols/anthropic-messages';
import { stubInternalModel, stubProviderModel } from '@floway-dev/test-utils';

const endpoint = stubChatCandidate({ model: { id: 'target', endpoints: { anthropicMessages: {} }, enabledFlags: new Set(['strip-billing-attribution']) } });
type Request = GatewayPipelineFacts['request.http'];

const serve = async (input: Record<string, unknown>, headers: Request['headers'] = []) => {
  let upstream: GatewayPipelineFacts['request.anthropicMessages'] | undefined;
  let upstreamHeaders: Request['headers'] | undefined;
  const ending = defineStage({
    name: 'anthropic-upstream',
    request: { needs: ['request.http', 'request.anthropicMessages'] },
    return: { provides: ['response.http', 'response.anthropicMessages'] },
    async execute(facts) {
      upstream = facts['request.anthropicMessages'];
      upstreamHeaders = facts['request.http'].headers;
      return {
        'response.http': { ...localResponseHead(429), headers: [['retry-after', '2']], body: null },
        'response.anthropicMessages': { kind: 'error', source: 'upstream', error: { type: 'error', error: { type: 'rate_limit_error', message: 'busy' } } },
      };
    },
  });
  const pipeline = compose('anthropic-test', {
    entry: ['request.http', 'provider.model'],
    exit: ['response.http', 'response.outcome'],
    stages: [
      parseAnthropicMessages, encodeAnthropicMessages,
      collectChat('anthropicMessages', collectAnthropicMessages, collectAnthropicMessagesStreamError),
      answerClaudeCodeProbe, stripBillingAttribution,
    ],
    ending,
  });
  const running = run(pipeline, {
    'provider.model': endpoint.model,
    'request.http': {
      url: 'https://floway.test/v1/messages',
      method: 'POST',
      headers,
      body: new TextEncoder().encode(JSON.stringify({
        model: 'requested', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }], ...input,
      })),
    },
  }, { services: {} as GatewayServices, signal: new AbortController().signal, waitUntil: () => {} });
  const answer = await running.result;
  const response = answer['response.http']!;
  const outcome = await running.read(answer['response.outcome']);
  if (!(response.body instanceof Uint8Array)) throw new Error('Expected collected JSON bytes');
  await running.done;
  return { response, body: JSON.parse(new TextDecoder().decode(response.body)) as unknown, upstream, upstreamHeaders, outcome };
};

test.each(['anthropic_beta', 'betas'])('rejects request body %s before routing', async field => {
  const { response, body, upstream, outcome } = await serve({ [field]: ['some-beta'] });
  expect(response.status).toBe(400);
  expect(body).toMatchObject({ error: { type: 'invalid_request_error', param: field } });
  expect(upstream).toBeUndefined();
  expect(outcome).toBe('local');
});

test('answers the Claude Code model probe locally with a complete zero-usage result', async () => {
  const { response, body, upstream } = await serve({ max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] }, [['user-agent', 'claude-cli/2.1.226']]);
  expect(response.status).toBe(200);
  expect(body).toMatchObject({ model: 'target', stop_reason: 'max_tokens', usage: { input_tokens: 0, output_tokens: 0 } });
  expect(upstream).toBeUndefined();
});

test.each([
  ['quota', 'claude-cli/2.1.226'],
  ['.', 'claude-cli/2.1.226'],
  ['Hi', 'other-client/1.0'],
])('forwards a one-token %s prompt from %s', async (prompt, agent) => {
  const { response, upstream } = await serve({ max_tokens: 1, messages: [{ role: 'user', content: prompt }] }, [['user-agent', agent]]);
  expect(response.status).toBe(429);
  expect(upstream?.messages).toEqual([{ role: 'user', content: prompt }]);
});

test('scrubs system billing markers and normalizes beta before the selected call', async () => {
  const { response, body, upstream, upstreamHeaders } = await serve({
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cch=abcde\nKeep this.' }],
  }, [['Anthropic-Beta', ' a, claude-code-20250219, '], ['anthropic-beta', ' b ']]);
  expect(upstream?.system).toEqual([{ type: 'text', text: 'Keep this.' }]);
  expect(upstreamHeaders).toEqual([['Anthropic-Beta', 'a,b']]);
  expect(response.status).toBe(429);
  expect(response.headers).toContainEqual(['retry-after', '2']);
  expect(body).toEqual({ type: 'error', error: { type: 'rate_limit_error', message: 'busy' } });
});

test.each([
  { flag: true, ua: 'ordinary-client', serialize: true, readFailure: false },
  { flag: false, ua: 'ordinary-client ai-sdk-anthropic/4.0.71', serialize: true, readFailure: false },
  { flag: false, ua: 'ordinary-client Anthropic/JS 0.131.0', serialize: true, readFailure: false },
  { flag: false, ua: 'ordinary-client ai-sdk-anthropic/4.0.710', serialize: false, readFailure: false },
  { flag: true, ua: 'ordinary-client', serialize: true, readFailure: true },
])('client content-block order through the Anthropic ingress (flag=$flag, ua=$ua, readFailure=$readFailure)', async ({ flag, ua, serialize, readFailure }) => {
  initRepo(new InMemoryRepo());
  const record: StoredUpstreamRecord = {
    id: 'anthropic-upstream', kind: 'custom', name: 'Anthropic', enabled: true,
    configVersion: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    state: {}, sortOrder: 0, usageRefreshIntervalMinutes: 0, flagOverrides: {}, disabledPublicModelIds: [],
    proxyFallbackList: [], modelPrefix: null, modelsCache: null, hue: 0,
    config: {
      baseUrl: 'https://upstream.test', apiKey: '', endpoints: { anthropicMessages: {} }, ingressHeadersRules: [],
      modelsFetch: { enabled: false, authStyle: 'bearer' }, models: [],
    },
  };
  const model = stubProviderModel({
    endpoints: { anthropicMessages: {} },
    enabledFlags: new Set(flag ? ['serialize-stream-items'] : []),
  });
  const candidate = { provider: createProvider(record), model: stubInternalModel({ providerModels: { [record.id]: model } }) };
  const events = [
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'test-model', content: [], usage: createAnthropicMessagesUsage(1, 0) } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'second' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'first' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_stop' },
  ];
  const wire = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  let upstreamRead = false;
  const upstreamBody = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!upstreamRead) {
        upstreamRead = true;
        controller.enqueue(new TextEncoder().encode(wire));
      } else if (readFailure) {
        controller.error(new UpstreamTransportError('test connection broke'));
      } else {
        controller.close();
      }
    },
  }, { highWaterMark: 0 });
  const services = await createGatewayServices('test', { id: 'key', serverSecret: '12'.repeat(32), openaiResponsesRetentionSeconds: 0 }, []);
  const running = run(anthropicMessagesIngress, {
    'request.http': {
      url: 'https://floway.test/v1/messages', method: 'POST', headers: [['user-agent', ua]],
      body: new TextEncoder().encode(JSON.stringify({
        model: 'test-model', max_tokens: 32, messages: [{ role: 'user', content: 'hello' }], stream: true,
      })),
    },
    'request.auth.apiKeyId': 'key',
    'request.auth.userId': 1,
    'request.auth.isAdmin': true,
    'request.auth.upstreamIds': null,
    'request.auth.randomizeUpstreams': false,
    'serve.runtimeLocation': 'test',
  }, {
    services: {
      ...services,
      catalogCandidates: async () => ({ candidates: [candidate], sawModel: true, failedUpstreams: [] }),
      fetcher: () => async () => ({ response: new Response(upstreamBody, { headers: { 'content-type': 'text/event-stream' } }) }),
    },
    signal: new AbortController().signal,
    waitUntil() {},
  });
  const answer = await running.result;
  const body = answer['response.http']?.body;
  if (!body || body instanceof Uint8Array) throw new Error('Expected encoded Anthropic SSE stream');
  const decoder = new TextDecoder();
  let encoded = '';
  for await (const item of running.read(body)) {
    if (!item.ok) throw new Error('Expected encoded bytes', { cause: item.error.cause });
    encoded += decoder.decode(item.value, { stream: true });
  }
  if (answer['response.usage']) await running.read(answer['response.usage']);
  if (answer['response.performance']) await running.read(answer['response.performance']);
  await expect(running.read(answer['response.outcome'])).resolves.toBe(readFailure ? 'upstream' : 'success');
  await running.done;
  const textBlocks = encoded.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  expect(textBlocks.filter(event => event.delta?.type === 'text_delta').map(event => event.delta.text)).toEqual(serialize ? ['first', 'second'] : ['second', 'first']);
  if (readFailure) {
    expect(textBlocks.at(-2)).toMatchObject({ type: 'message_stop' });
    expect(textBlocks.at(-1)).toMatchObject({ type: 'error', error: { message: 'test connection broke' } });
  } else {
    expect(textBlocks.at(-1)).toMatchObject({ type: 'message_stop' });
  }
});
