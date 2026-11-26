import { expect, test } from 'vitest';

import { openAIResponsesAffinityOutput } from '../../../../src/data-plane/chat/openai-responses/affinity/output-stage.ts';
import { lowerOpenAIResponsesAgentMessage } from '../../../../src/data-plane/chat/openai-responses/agent-message.ts';
import { normalizeOpenAIResponsesAssistantInput } from '../../../../src/data-plane/chat/openai-responses/assistant-input.ts';
import { encodeOpenAIResponses } from '../../../../src/data-plane/chat/openai-responses/encode.ts';
import { openAIResponsesHostedTools } from '../../../../src/data-plane/chat/openai-responses/hosted-tools.ts';
import type { OpenAIResponsesDelivery } from '../../../../src/data-plane/chat/openai-responses/pipeline-facts.ts';
import { stripOpenAIResponsesPromptCacheKey } from '../../../../src/data-plane/chat/openai-responses/prompt-cache-key.ts';
import { disableOpenAIResponsesReasoningOnForcedToolChoice } from '../../../../src/data-plane/chat/openai-responses/reasoning-tool-choice.ts';
import { applyOpenAIResponsesRoleCompatibility } from '../../../../src/data-plane/chat/openai-responses/role-compatibility.ts';
import { forceOpenAIResponsesStoreFalse } from '../../../../src/data-plane/chat/openai-responses/store-false.ts';
import { openAIResponsesFailureEvents, openAIResponsesProtocolError } from '../../../../src/data-plane/chat/openai-responses/stream-error.ts';
import { answerOpenAIResponsesWebSocketWarmup } from '../../../../src/data-plane/chat/openai-responses/warmup.ts';
import { AffinityCodec } from '../../../../src/data-plane/chat/shared/affinity/carrier.ts';
import { createSidecarCodecFactory } from '../../../../src/data-plane/chat/shared/sidecar-codec.ts';
import type { GatewayPipelineFacts } from '../../../../src/data-plane/pipeline/facts.ts';
import type { GatewayServices } from '../../../../src/data-plane/pipeline/services.ts';
import { DEFAULT_WEB_SEARCH_CONFIG } from '../../../../src/data-plane/tools/web-search/config.ts';
import { factSpace, run, type Result } from '@floway-dev/pipeline';
import { type CanonicalOpenAIResponsesPayload, type OpenAIResponsesResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { toProviderModelFact, type ProtocolStreamError } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

type TestFacts = GatewayPipelineFacts & { 'request.ws.responseId': string; 'request.delivery': OpenAIResponsesDelivery };
const { compose, defineStage } = factSpace<TestFacts, GatewayServices>();
const keys = ['response.http', 'response.openaiResponses'] as const;
const http = { status: 200, statusText: '', headers: [], body: null };
const model = toProviderModelFact(stubProviderModel({
  id: 'model', endpoints: { openaiResponses: {} }, enabledFlags: new Set(['openai-responses-web-search-shim']),
}));
const response = (status: OpenAIResponsesResultEx['status']): OpenAIResponsesResultEx => ({
  id: 'upstream', object: 'response', model: 'model', status, output: [], error: null, incomplete_details: null,
});
const services = {
  affinity: new AffinityCodec('99'.repeat(32)),
  sidecarCodec: createSidecarCodecFactory('99'.repeat(32)),
  localWebSearch: {
    passthroughConfiguration: async () => DEFAULT_WEB_SEARCH_CONFIG.passthroughOpenAiSearch,
    getProvider: async () => ({ type: 'disabled' }),
    pageCache: new Map(),
  },
} as GatewayServices;

test('a failed resource retains the same projected opaque item already delivered to its client', async () => {
  const reasoning = { type: 'reasoning' as const, id: 'rs_test', summary: [], encrypted_content: 'upstream-opaque' };
  const error = { code: 'server_error', message: 'native failure' };
  const terminal = defineStage({
    name: 'test.generation',
    request: { needs: [] },
    return: { provides: keys },
    async execute(_facts, scope) {
      const stream = scope.createStream(async function* (): AsyncGenerator<Result<OpenAIResponsesStreamEventEx, ProtocolStreamError>> {
        yield { ok: true, value: { type: 'response.created', response: response('in_progress') } };
        yield { ok: true, value: { type: 'response.output_item.done', output_index: 0, item: reasoning } };
        yield {
          ok: false,
          error: openAIResponsesProtocolError(new Error(error.message), {
            failed: { type: 'response.failed', response: { ...response('failed'), output: [reasoning], error } },
          }),
        };
      });
      return { 'response.http': http, 'response.openaiResponses': { kind: 'stream', stream } };
    },
  });
  const pipeline = compose('responses-affinity-failure-test', {
    entry: ['provider.model', 'provider.upstream', 'request.aliasRules?'],
    exit: keys, stages: [openAIResponsesAffinityOutput], ending: terminal,
  });
  const controller = new AbortController();
  const running = run(pipeline, {
    'provider.model': model,
    'provider.upstream': { id: 'test', name: 'Test upstream', kind: 'custom', config: {} },
  }, { services, signal: controller.signal, waitUntil: () => {} });
  const outcome = (await running.result)['response.openaiResponses'];
  if (outcome.kind !== 'stream') throw new Error('Expected the projected stream');
  const items = await Array.fromAsync(running.read(outcome.stream));
  controller.abort();
  await running.done;
  const done = items.find(item => item.ok && item.value.type === 'response.output_item.done');
  const failure = items.at(-1);
  if (!done?.ok || done.value.type !== 'response.output_item.done' || failure?.ok !== false) {
    throw new Error('Expected one completed item and a failed outcome');
  }
  expect(openAIResponsesFailureEvents(failure.error).failed?.response.output).toEqual([done.value.item]);
  expect(done.value.item).not.toEqual(reasoning);
});

test('flagged request stages apply their canonical changes and share untouched input', async () => {
  let outbound: CanonicalOpenAIResponsesPayload | undefined;
  const terminal = defineStage({
    name: 'test.generation',
    request: { needs: ['request.openaiResponses'] },
    return: { provides: keys },
    async execute(facts) {
      outbound = facts['request.openaiResponses'];
      return { 'response.http': http, 'response.openaiResponses': { kind: 'result', result: response('completed') } };
    },
  });
  const pipeline = compose('responses-request-stages-test', {
    entry: ['request.openaiResponses', 'provider.model'], exit: keys, ending: terminal,
    stages: [
      normalizeOpenAIResponsesAssistantInput, lowerOpenAIResponsesAgentMessage, disableOpenAIResponsesReasoningOnForcedToolChoice,
      applyOpenAIResponsesRoleCompatibility, stripOpenAIResponsesPromptCacheKey, forceOpenAIResponsesStoreFalse,
    ],
  });
  const original: CanonicalOpenAIResponsesPayload = {
    model: 'model', tool_choice: 'required', reasoning: { effort: 'high' }, prompt_cache_key: 'cache', store: true,
    input: [
      { type: 'message', role: 'system', content: 'system' },
      { type: 'message', role: 'user', content: 'unchanged' },
      { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: 'replay' }] },
      { type: 'agent_message', author: 'sender', recipient: 'receiver', content: [{ type: 'input_text', text: 'signal' }] },
    ],
  };
  const controller = new AbortController();
  const running = run(pipeline, {
    'request.openaiResponses': original,
    'provider.model': {
      ...model, enabledFlags: [
        'disable-reasoning-on-forced-tool-choice', 'rewrite-system-to-developer',
        'openai-responses-agent-message-shim', 'strip-prompt-cache-key', 'openai-responses-store-false',
      ],
    },
  }, { services, signal: controller.signal, waitUntil: () => {} });
  expect((await running.result)['response.openaiResponses'].kind).toBe('result');
  controller.abort();
  await running.done;
  expect(outbound).toMatchObject({ reasoning: { effort: 'none' }, store: false });
  expect(outbound).not.toHaveProperty('prompt_cache_key');
  expect(outbound?.input[0]).toMatchObject({ role: 'developer', content: 'system' });
  expect(outbound?.input[1]).toBe(original.input[1]);
  expect(outbound?.input[2]).toMatchObject({ content: [{ type: 'output_text', text: 'replay' }] });
  expect(outbound?.input[3]).toMatchObject({ type: 'message', role: 'user' });
});

test('warmup answers locally only when a WebSocket response ID is present', async () => {
  const normal = defineStage({
    name: 'test.generation',
    request: { needs: [] },
    return: { provides: keys },
    async execute() {
      return { 'response.http': http, 'response.openaiResponses': { kind: 'error', source: 'local', error: 'dial' } };
    },
  });
  const pipeline = compose('responses-warmup-test', {
    entry: ['request.openaiResponses', 'provider.model', 'request.ws.responseId?'],
    exit: keys, stages: [answerOpenAIResponsesWebSocketWarmup], ending: normal,
  });
  const request = { 'request.openaiResponses': { model: 'model', input: [], generate: false }, 'provider.model': model };
  const controller = new AbortController();
  const options = { services, signal: controller.signal, waitUntil: (_: Promise<unknown>) => {} };
  const fromHttp = run(pipeline, request, options);
  expect((await fromHttp.result)['response.openaiResponses']).toEqual({ kind: 'error', source: 'local', error: 'dial' });
  await fromHttp.done;

  const fromWs = run(pipeline, { ...request, 'request.ws.responseId': 'resp_ws' }, options);
  const outcome = (await fromWs.result)['response.openaiResponses'];
  if (outcome.kind !== 'stream') throw new Error('Expected the WebSocket warmup stream');
  const events = await Array.fromAsync(fromWs.read(outcome.stream));
  expect(events.at(-1)).toMatchObject({ ok: true, value: { type: 'response.completed', response: { id: 'resp_ws', output: [] } } });
  controller.abort();
  await fromWs.done;
});

test.each(['panic', 'abort', 'post-header-abort', 'search-abort', 'local-refusal', 'midstream-refusal'] as const)('hosted tools preserve the %s outcome at its owning call boundary', async mode => {
  let rounds = 0;
  const failure = new Error(`ReAct second generation stage ${mode}`);
  const secondRound = Promise.withResolvers<void>();
  const searchStarted = Promise.withResolvers<void>();
  const call = {
    type: 'function_call' as const, id: 'fc_search', call_id: 'call_search', name: 'web_search',
    arguments: '{"search_query":[{"q":"fixture"}]}', status: 'completed',
  };
  const generation = defineStage({
    name: 'test.generation',
    request: { needs: ['request.openaiResponses'] },
    return: { provides: keys },
    async execute(facts, scope) {
      const refusal = {
        'response.http': { ...http, status: 400 },
        'response.openaiResponses': { kind: 'error' as const, source: 'local' as const, error: { error: { message: 'refused locally' } } },
      };
      if (mode === 'local-refusal') return refusal;
      if (++rounds === 2) {
        expect(facts['request.openaiResponses'].input).toContainEqual(expect.objectContaining({ type: 'function_call_output' }));
        if (mode === 'panic') throw failure;
        if (mode === 'midstream-refusal') return refusal;
        secondRound.resolve();
        await new Promise<void>(resolve => scope.signal.addEventListener('abort', () => resolve(), { once: true }));
        return {
          'response.http': mode === 'post-header-abort' ? {
            ...http, startedAt: 0, headers: [['x-request-id', 'exchange']],
          } : null,
          'response.openaiResponses': { kind: 'error', source: 'local', error: { error: { message: 'Upstream request cancelled' } } },
        };
      }
      const stream = scope.createStream(async function* (): AsyncGenerator<Result<OpenAIResponsesStreamEventEx, ProtocolStreamError>> {
        yield { ok: true, value: { type: 'response.created', response: response('in_progress') } };
        yield { ok: true, value: { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } } };
        yield { ok: true, value: { type: 'response.output_item.done', output_index: 0, item: call } };
        yield { ok: true, value: { type: 'response.completed', response: response('completed') } };
      });
      return { 'response.http': http, 'response.openaiResponses': { kind: 'stream', stream } };
    },
  });
  const pipeline = compose('responses-hosted-tools-test', {
    entry: [
      'request.http', 'request.openaiResponses', 'provider.model', 'request.auth.apiKeyId', 'request.auth.userId',
      'request.auth.isAdmin', 'request.auth.upstreamIds', 'request.auth.randomizeUpstreams', 'serve.runtimeLocation',
    ],
    exit: keys, stages: [openAIResponsesHostedTools], ending: generation,
  });
  const controller = new AbortController();
  const requestServices: GatewayServices = mode !== 'search-abort' ? services : {
    ...services,
    localWebSearch: {
      ...services.localWebSearch,
      getProvider: async () => ({
        type: 'enabled', provider: 'tavily', impl: {
          async search({ signal }) {
            if (signal === undefined) throw new TypeError('Expected the search operation signal');
            searchStarted.resolve();
            return await new Promise((_, reject) => {
              signal.addEventListener('abort', () => reject(new Error('backend aborted', { cause: signal.reason })), { once: true });
            });
          },
          async fetchPage() { throw new Error('Unexpected page fetch'); },
        },
      }),
    },
  };
  const running = run(pipeline, {
    'request.http': { method: 'POST', url: 'https://test.example/responses', headers: [], body: null },
    'request.openaiResponses': { model: 'model', input: [], tools: [{ type: 'web_search' }] },
    'provider.model': model,
    'request.auth.apiKeyId': 'test', 'request.auth.userId': 1, 'request.auth.isAdmin': false,
    'request.auth.upstreamIds': null, 'request.auth.randomizeUpstreams': false, 'serve.runtimeLocation': 'TEST',
  }, { services: requestServices, signal: controller.signal, waitUntil: () => {} });
  const outcome = (await running.result)['response.openaiResponses'];
  if (mode === 'local-refusal') {
    expect(outcome).toMatchObject({ kind: 'error', source: 'local', error: { error: { message: 'refused locally' } } });
    controller.abort();
    await running.done;
    return;
  }
  if (outcome.kind !== 'stream') throw new Error('Expected the hosted tool stream');
  const emitted: OpenAIResponsesStreamEventEx[] = [];
  const errors: ProtocolStreamError[] = [];
  const drain = async () => {
    for await (const item of running.read(outcome.stream)) {
      if (item.ok) emitted.push(item.value);
      else errors.push(item.error);
    }
  };
  const consumed = drain();
  if (mode === 'panic') {
    await expect(consumed).rejects.toThrow();
    controller.abort();
    await expect(running.done).rejects.toThrow();
  } else if (mode === 'midstream-refusal') {
    await consumed;
    controller.abort();
    await running.done;
    expect(errors).toHaveLength(1);
    expect(openAIResponsesFailureEvents(errors[0]).notification).toMatchObject({
      type: 'error', error: { message: 'refused locally' },
    });
  } else {
    await (mode === 'search-abort' ? searchStarted.promise : secondRound.promise);
    controller.abort(failure);
    await consumed;
    await running.done;
    expect(errors).toEqual([{ kind: 'abort', cause: failure }]);
  }
  expect(rounds).toBe(mode === 'search-abort' ? 1 : 2);
  expect(emitted).toContainEqual(expect.objectContaining({
    type: mode === 'search-abort' ? 'response.web_search_call.searching' : 'response.web_search_call.completed',
  }));
});

test('the SSE encoder renders paired failure payloads before its discarded source settles', async () => {
  const sourceReturned = Promise.withResolvers<void>();
  const terminal = defineStage({
    name: 'test.failure',
    request: { needs: [] },
    return: { provides: keys },
    async execute(_facts, scope) {
      const stream = scope.createStream(async function* (producer): AsyncGenerator<Result<OpenAIResponsesStreamEventEx, ProtocolStreamError>> {
        yield { ok: true, value: { type: 'response.created', response: response('in_progress') } };
        yield {
          ok: false,
          error: openAIResponsesProtocolError(new Error('wire failure'), {
            notification: { type: 'error', code: 'server_error', message: 'wire failure' },
            failed: { type: 'response.failed', response: { ...response('failed'), error: { code: 'server_error', message: 'wire failure' } } },
          }),
        };
        if (!producer.signal.aborted) {
          await new Promise<void>(resolve => producer.signal.addEventListener('abort', () => resolve(), { once: true }));
        }
        sourceReturned.resolve();
      });
      return { 'response.http': http, 'response.openaiResponses': { kind: 'stream', stream } };
    },
  });
  const pipeline = compose('responses-encoder-test', {
    entry: ['request.delivery'], exit: ['response.http', 'response.outcome'], stages: [encodeOpenAIResponses], ending: terminal,
  });
  const controller = new AbortController();
  const running = run(pipeline, {
    'request.delivery': { stream: true, createdAt: 123 },
  }, { services, signal: controller.signal, waitUntil: () => {} });
  const answer = await running.result;
  const body = answer['response.http']?.body;
  const verdict = running.read(answer['response.outcome']);
  if (!body || body instanceof Uint8Array) throw new Error('Expected an encoded SSE body');
  let text = '';
  for await (const item of running.read(body)) {
    if (!item.ok) throw item.error.cause;
    text += new TextDecoder().decode(item.value);
  }
  await running.done;
  await expect(verdict).resolves.toBe('upstream');
  expect(text.match(/event: error/g)).toHaveLength(1);
  expect(text.match(/event: response.failed/g)).toHaveLength(1);
  expect(text).not.toContain('[DONE]');
  expect(await Promise.race([sourceReturned.promise.then(() => true), Promise.resolve(false)])).toBe(false);
  controller.abort();
  await sourceReturned.promise;
});
