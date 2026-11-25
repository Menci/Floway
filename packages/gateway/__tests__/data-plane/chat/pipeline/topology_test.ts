import { Hono } from 'hono';
import { expect, test } from 'vitest';

import { chatEgress } from '../../../../src/data-plane/chat/pipeline/egress.ts';
import { chatBodyEntry, chatBodyExit, chatBodyTargets, enterChatBody } from '../../../../src/data-plane/chat/pipeline/topology.ts';
import { discoverCandidates } from '../../../../src/data-plane/pipeline/discover-candidates.ts';
import { encodeResponse } from '../../../../src/data-plane/pipeline/encode-response.ts';
import { gatewayFactSpace, httpEntry } from '../../../../src/data-plane/pipeline/facts.ts';
import { failover } from '../../../../src/data-plane/pipeline/failover.ts';
import { servePipeline } from '../../../../src/data-plane/pipeline/host.ts';
import { requestBody } from '../../../../src/data-plane/pipeline/request-body.ts';
import { jsonResponseBody, responseHead } from '../../../../src/data-plane/pipeline/response.ts';
import { createGatewayServices, type GatewayServices } from '../../../../src/data-plane/pipeline/services.ts';
import { stripFlowayAuth } from '../../../../src/data-plane/pipeline/strip-floway-auth.ts';
import type { AuthVars } from '../../../../src/middleware/auth.ts';
import { saveUpstreamForTest } from '../../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, setupAppTest, testAdminUser, warmModelsForTest } from '../../../test-utils/app.ts';
import { flushBackground } from '../../../test-utils/background-tracker.ts';
import { readHttpBody } from '@floway-dev/http';
import { move } from '@floway-dev/pipeline';
import { isJsonObject } from '@floway-dev/protocols/common';
import { formatOpenAIChatCompletionsError, type OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import { withMockedFetch } from '@floway-dev/test-utils';

const protocol = 'openaiChatCompletions';
const requestKey = 'request.openaiChatCompletions';
const responseKey = 'response.openaiChatCompletions';
const { compose, defineStage } = gatewayFactSpace<GatewayServices>();

const parse = defineStage({
  name: 'test.parse-openai-chat-completions',
  through: {
    request: { needs: ['request.http'], provides: [requestKey, 'serve.model', 'request.delivery'], consumes: [] },
    response: { needs: ['response.http'], provides: [], consumes: [] },
  },
  return: { provides: ['response.http'] },
  async execute(facts, scope) {
    const raw = await readHttpBody(facts['request.http'].body);
    if (!raw.ok) throw raw.error.cause;
    const payload: unknown = JSON.parse(new TextDecoder().decode(raw.value));
    if (!isJsonObject(payload) || typeof payload.model !== 'string' || !Array.isArray(payload.messages)) {
      return {
        'response.http': move(jsonResponseBody(responseHead(400), formatOpenAIChatCompletionsError(400, 'Expected model and messages.'))),
      };
    }

    return await scope.next({
      ...facts,
      'serve.model': payload.model,
      [requestKey]: move(payload as OpenAIChatCompletionsPayloadEx),
      'request.delivery': move({
        kind: protocol,
        stream: payload.stream === true,
        includeUsageChunk: false,
        expectedChoices: 1,
      }),
    });
  },
});

const encode = encodeResponse(responseKey, (outcome, http, delivery, scope) => {
  expect(delivery).toEqual({ kind: protocol, stream: true, includeUsageChunk: false, expectedChoices: 1 });
  if (outcome.kind !== 'stream') throw new TypeError('Expected a stream');
  const encoder = new TextEncoder();
  const body = scope.wrapStream(outcome.stream, async function* (items) {
    for await (const item of items) {
      if (item.ok) yield { ok: true, value: encoder.encode(JSON.stringify(item.value)) };
      else yield { ok: false, error: { kind: 'transport', cause: item.error.cause } };
    }
  });
  return { ...http, body };
});

const entry = chatBodyEntry(protocol);
const exit = chatBodyExit(protocol);
const egress = compose('test.openaiChatCompletions.egress', {
  entry,
  exit,
  ...chatEgress(protocol, {
    usage: { kind: 'unbillable' },
    firstOutput: () => false,
    verdict: () => 'complete',
  }),
});
const bodyTargets = chatBodyTargets(protocol, egress, []);
const body = compose('test.openaiChatCompletions.body', { entry, exit, stages: [], ...bodyTargets });
const ingress = compose('test.openaiChatCompletions.ingress', {
  entry: httpEntry,
  exit: ['response.http'],
  stages: [
    requestBody,
    stripFlowayAuth,
    parse,
    encode,
    discoverCandidates('chat'),
    failover(responseKey, () => { throw new Error('Expected the native model candidate'); }, bodyTargets.serves),
  ],
  ...enterChatBody(protocol, body),
});

test('Chat Completions ingress and body enter the native egress and preserve the protocol payload', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    config: {
      baseUrl: 'https://native-chat.example.com',
      ingressHeadersRules: [],
      apiKey: 'native-upstream-key',
      endpoints: {},
      modelsFetch: { enabled: false, authStyle: 'bearer' },
      models: [{ upstreamModelId: 'native-model', endpoints: { openaiChatCompletions: {} } }],
    },
  }));
  const app = new Hono<{ Variables: AuthVars }>();
  app.post('/', c => {
    c.set('apiKey', apiKey);
    c.set('user', testAdminUser);
    return servePipeline(c, ingress, createGatewayServices);
  });
  const inbound = {
    model: 'native-model',
    messages: [{ role: 'user', content: 'hello' }],
    stream: true,
    extension: { mode: 'verbatim' },
  };
  const outbound = {
    object: 'chat.completion.chunk',
    id: 'chatcmpl-native',
    created: 1,
    model: 'native-model',
    choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: 'stop' }],
    extension: { mode: 'verbatim' },
  };
  let upstreamCalls = 0;
  await withMockedFetch(async request => {
    upstreamCalls++;
    expect(request.url).toBe('https://native-chat.example.com/v1/chat/completions');
    expect(request.headers.get('authorization')).toBe('Bearer native-upstream-key');
    expect(await request.json()).toEqual(inbound);
    return new Response(`data: ${JSON.stringify(outbound)}\n\ndata: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream', 'x-request-id': 'native-request' },
    });
  }, async () => {
    await warmModelsForTest();
    const request = (payload: unknown) => app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const invalid = await request({ model: 'native-model' });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { message: 'Expected model and messages.' } });
    expect(upstreamCalls).toBe(0);

    const response = await request(inbound);
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('native-request');
    expect(JSON.parse(text)).toEqual(outbound);
    expect(upstreamCalls).toBe(1);
    await flushBackground();
  });
});
