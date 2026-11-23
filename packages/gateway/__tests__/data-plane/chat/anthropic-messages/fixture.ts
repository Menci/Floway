import { createAnthropicMessagesBody, createAnthropicMessagesCountBody } from '../../../../src/data-plane/chat/anthropic-messages/body.ts';
import { anthropicMessagesCountEgress, anthropicMessagesEgress } from '../../../../src/data-plane/chat/anthropic-messages/egress.ts';
import { createAnthropicMessagesCountIngress, createAnthropicMessagesIngress } from '../../../../src/data-plane/chat/anthropic-messages/ingress.ts';
import type { AnthropicMessagesFrame } from '../../../../src/data-plane/chat/anthropic-messages/stages/facts.ts';
import { createNonOpenAIResponsesSourceStore } from '../../../../src/data-plane/chat/openai-responses/items/store.ts';
import { AffinityCodec } from '../../../../src/data-plane/chat/shared/affinity/carrier.ts';
import type { ChatBodyTargets, ChatOutcomeFacts } from '../../../../src/data-plane/chat/shared/route-body.ts';
import { createSidecarCodecFactory } from '../../../../src/data-plane/chat/shared/sidecar-codec.ts';
import type { HttpOutput } from '../../../../src/data-plane/pipeline/edge-http.ts';
import { type GatewayHttpFacts, httpRequestFacts, startGatewayRun } from '../../../../src/data-plane/pipeline/host.ts';
import type { GatewayServices } from '../../../../src/data-plane/pipeline/services.ts';
import { createProviderRuntimeServices } from '../../../../src/data-plane/providers/upstreams.ts';
import { writeHttpResponse } from '../../../../src/data-plane/shared/http-writer.ts';
import { serializeSseFrame } from '../../../../src/data-plane/shared/sse.ts';
import { chatUpstream, fetcherFrom, providersFrom } from '../shared/fixture.ts';
import type { FetchInit } from '@floway-dev/http';
import { Bytes, compose, defineEnding, type ErrorSnapshot, link, type RunEvent } from '@floway-dev/pipeline';
import { type AnthropicMessagesPayload, anthropicMessagesProtocolFrameToSSEFrame, createAnthropicMessagesUsage, toAnthropicMessagesUsageDelta } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import { jsonResponse } from '@floway-dev/test-utils';

const secret = '22'.repeat(32);
export const messagesPayload = (overrides: Partial<AnthropicMessagesPayload> = {}): AnthropicMessagesPayload => ({
  model: 'test-model', max_tokens: 32, messages: [{ role: 'user', content: 'hello' }], ...overrides,
});

export const defaultFrames = async function* (): AsyncGenerator<AnthropicMessagesFrame> {
  const usage = createAnthropicMessagesUsage(3, 5);
  yield eventFrame({
    type: 'message_start',
    message: {
      id: 'msg_1', type: 'message', role: 'assistant', model: 'test-model', content: [],
      stop_reason: null, stop_details: null, stop_sequence: null, container: null, diagnostics: null, usage,
    },
  });
  yield eventFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'answer', citations: null } });
  yield eventFrame({ type: 'content_block_stop', index: 0 });
  yield eventFrame({ type: 'message_delta', delta: { container: null, stop_reason: 'end_turn', stop_details: null, stop_sequence: null }, usage: toAnthropicMessagesUsageDelta(usage) });
  yield eventFrame({ type: 'message_stop' });
  yield doneFrame();
};

export const generateReply = (frames: AsyncIterable<AnthropicMessagesFrame> | Iterable<AnthropicMessagesFrame> = defaultFrames()): Response => {
  const iterate = async function* () {
    for await (const frame of frames) {
      const wire = anthropicMessagesProtocolFrameToSSEFrame(frame);
      if (wire !== null) yield new TextEncoder().encode(serializeSseFrame(wire));
    }
  };
  const iterator = iterate();
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
};

export const requestPayload = <Payload = AnthropicMessagesPayload>(init: FetchInit): Payload => {
  if (!(init.body instanceof Uint8Array)) throw new TypeError('Expected buffered JSON bytes');
  return JSON.parse(new TextDecoder().decode(init.body)) as Payload;
};

export const messagesUpstream = (options: Partial<Parameters<typeof chatUpstream>[0]> = {}) => chatUpstream({
  endpoints: { anthropicMessages: {} },
  fetcher: async url => new URL(url).pathname.endsWith('/count_tokens') ? jsonResponse({ input_tokens: 42 }) : generateReply(),
  ...options,
});

type UnusedSpace = HttpOutput & ChatOutcomeFacts<'anthropicMessages'> & ChatOutcomeFacts<'openaiResponses'> & ChatOutcomeFacts<'openaiChatCompletions'>;
const unusedExit = ['response.http', 'response.anthropicMessages', 'response.openaiResponses', 'response.openaiChatCompletions'] as const;
export const unusedBody = compose<UnusedSpace, GatewayServices>()('unused translation body', {
  entry: [], exit: unusedExit, stages: [],
  ending: defineEnding({
    name: 'unexpected', request: { needs: [] },
    return: { provides: unusedExit },
    execute: async () => { throw new Error('Unexpected translation'); },
  }),
});

export const messagesFixture = (upstreams = [messagesUpstream()], options: {
  readonly egress?: ChatBodyTargets<'anthropicMessages'>['egress'];
  readonly responses?: ChatBodyTargets<'anthropicMessages'>['responses'];
  readonly webSearchProvider?: GatewayServices['webSearchProvider'];
  readonly recordSearchUsage?: GatewayServices['searchUsageStore']['record'];
  readonly failedUpstreams?: readonly string[];
  readonly dumpRetentionSeconds?: number;
} = {}) => {
  const events: RunEvent[] = [];
  const usage: Parameters<GatewayServices['usageStore']['record']>[0][] = [];
  const performance: Parameters<GatewayServices['performanceStore']['record']>[0][] = [];
  const requestedModels: string[] = [];
  const directory = providersFrom(upstreams);
  const services: GatewayServices = {
    ...createProviderRuntimeServices(),
    providers: {
      enumerate: async (...facts) => {
        requestedModels.push(facts[1]);
        const result = await directory.enumerate(...facts);
        return { ...result, failedUpstreams: options.failedUpstreams ?? result.failedUpstreams };
      },
    },
    modelsRefresh: async () => { throw new Error('Unexpected refresh'); },
    fetcher: fetcherFrom(upstreams),
    affinityCodec: new AffinityCodec(secret),
    sidecarCodecs: createSidecarCodecFactory(secret),
    responsesStore: () => createNonOpenAIResponsesSourceStore('test-key'),
    usageStore: {
      record: async row => {
        usage.push(row);
        return { usage: 'written', lastUsedAt: 'written' };
      },
    },
    performanceStore: { record: async row => { performance.push(row); } },
    searchUsageStore: { record: options.recordSearchUsage ?? (async () => {}) },
    webSearchProvider: options.webSearchProvider ?? Object.assign(
      async () => ({ type: 'disabled' as const }),
      { alphaSearch: async () => ({ enabled: false, upstreamId: '', model: '' }) },
    ),
  };
  const body = createAnthropicMessagesBody({
    egress: options.egress ?? anthropicMessagesEgress,
    responses: options.responses ?? unusedBody,
    chatCompletions: unusedBody,
  });
  const countBody = createAnthropicMessagesCountBody({ egress: anthropicMessagesCountEgress });
  const generate = createAnthropicMessagesIngress(body);
  const count = createAnthropicMessagesCountIngress(countBody);
  link([generate, count]);

  const send = async (payload: unknown, opts: {
    readonly count?: boolean; readonly headers?: HeadersInit; readonly uploadError?: ErrorSnapshot; readonly rawBody?: string;
  } = {}) => {
    const path = opts.count ? '/v1/messages/count_tokens' : '/v1/messages';
    const request = new Request(`https://gateway.test${path}`, { method: 'POST', headers: opts.headers });
    const input: GatewayHttpFacts = {
      'request.http': httpRequestFacts(request, opts.uploadError === undefined
        ? Bytes.fromUtf8(opts.rawBody ?? JSON.stringify(payload))
        : { kind: 'upload-error', error: opts.uploadError }),
      'request.auth.apiKeyId': 'test-key',
      'request.auth.user': { id: 1, isAdmin: false },
      'request.route.upstreamIds': null,
      'request.route.randomizeUpstreams': false,
      'request.route.runtimeLocation': 'SJC',
      'request.startedAt': Date.now(),
    };
    const background: Promise<unknown>[] = [];
    const handle = startGatewayRun(opts.count ? count : generate, input, {
      apiKey: {
        id: 'test-key', userId: 1, name: 'Test key', key: 'sk-test', serverSecret: secret,
        createdAt: '2026-01-01T00:00:00.000Z', upstreamIds: null, randomizeUpstreams: false, deletedAt: null,
        dumpRetentionSeconds: options.dumpRetentionSeconds ?? null, openaiResponsesRetentionSeconds: 0,
      },
      request: input['request.http'],
      scheduler: task => { background.push(task); },
      services, finalizationTimeoutMs: 1_000, events: event => { events.push(event); },
    });
    const facts = await handle.result;
    const done = Promise.all(background).then(() => handle.done);
    return { facts, response: writeHttpResponse(facts['response.http']), done };
  };

  return { send, events, usage, performance, requestedModels };
};
