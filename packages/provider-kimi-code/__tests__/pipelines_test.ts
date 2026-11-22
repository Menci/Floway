import { expect, test, vi } from 'vitest';

import { config, profile, recentState, record, usage } from './fixtures.ts';
import { selectKimiCodeModel } from '../src/model-selection.ts';
import { createKimiCodePipelines } from '../src/pipelines.ts';
import { createKimiCodeProvider } from '../src/provider.ts';
import { createDumpEncoder, runPipeline, secret, type EncodedDumpEvent, type HeaderEntry, type Pipeline, type RawRunEvent } from '@floway-dev/pipeline';
import { initProviderRepo, isReplayableBody, readManagedBytes, toProviderModelFacts, type Fetcher, type FetchInit, type ProviderModelFacts, type ProviderPipelineAnthropicMessagesCountTokensInput, type ProviderPipelineAnthropicMessagesInput, type ProviderPipelineOpenAIChatCompletionsInput, type ProviderPipelineOpenAIResponsesInput, type ProviderPipelineServices } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

const model = (overrides: {
  readonly id: string;
  readonly upstreamModelId: string;
  readonly providerData?: unknown;
}): ProviderModelFacts => toProviderModelFacts(stubProviderModel({
  id: overrides.id,
  upstreamModelId: overrides.upstreamModelId,
  ...(overrides.providerData === undefined ? {} : { providerData: overrides.providerData }),
}));

const dualLane = model({
  id: 'kimi-k3.1-pro',
  upstreamModelId: 'k3.1-pro',
  providerData: { standardModelId: 'k3.1-pro', fastModelId: 'k3.1-pro-highspeed' },
});
const standardOnly = model({ id: 'kimi-k3', upstreamModelId: 'k3', providerData: { standardModelId: 'k3' } });
const fastOnly = model({ id: 'kimi-k2.7-code', upstreamModelId: 'kimi-for-coding-highspeed', providerData: { fastModelId: 'kimi-for-coding-highspeed' } });

interface CapturedRequest {
  readonly url: string;
  readonly init: FetchInit;
  readonly headers: Headers;
  readonly body: unknown;
}

const readBody = async (init: FetchInit): Promise<unknown> => {
  if (init.body === undefined || init.body === null) return undefined;
  if (isReplayableBody(init.body)) return await new Response(init.body.open()).json();
  return await new Response(init.body as BodyInit).json();
};

const sse = (body: string, headers: Record<string, string> = {}): Response => new Response(body, {
  status: 200,
  headers: { 'content-type': 'text/event-stream; charset=utf-8', ...headers },
});

const chatSse = (tier?: string): Response => sse(`data: ${JSON.stringify({
  id: 'chat-turn', object: 'chat.completion.chunk', created: 1, model: 'k3.1-pro-highspeed', choices: [],
  ...(tier === undefined ? {} : { service_tier: tier }),
})}\n\ndata: [DONE]\n\n`);

const responsesSse = (tier?: string): Response => sse([
  ['response.created', 'in_progress'],
  ['response.completed', 'completed'],
].map(([type, status]) => `event: ${type}\ndata: ${JSON.stringify({
  type,
  response: {
    id: 'responses-turn', object: 'response', status, output: [], model: 'k3.1-pro-highspeed',
    created_at: 1, error: null, incomplete_details: null, instructions: null, metadata: null,
    parallel_tool_calls: true, temperature: 1, tool_choice: 'auto', tools: [], top_p: 1,
    ...(tier === undefined ? {} : { service_tier: tier }),
  },
})}\n\n`).join(''));

const messagesSse = (speed?: string): Response => sse([
  `event: message_start\ndata: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: 'messages-turn', type: 'message', role: 'assistant', model: 'k3.1-pro-highspeed', content: [],
      stop_reason: null, stop_sequence: null, container: null,
      usage: { input_tokens: 1, output_tokens: 0, ...(speed === undefined ? {} : { speed }) },
    },
  })}\n\n`,
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join(''));

interface RunOptions {
  readonly waitUntil?: (promise: Promise<unknown>) => void;
  readonly traceSink?: {
    push: (event: RawRunEvent) => void;
    registerSecretPlaintext?: (plaintext: string) => void;
  };
}

const run = async <In extends object, Out>(
  selectedPipeline: Pipeline<In, Out, ProviderPipelineServices>,
  input: In,
  responder: (url: string, init: FetchInit) => Response | Promise<Response>,
  options: RunOptions = {},
): Promise<{ readonly outcome: Out; readonly requests: readonly CapturedRequest[] }> => {
  const requests: CapturedRequest[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const captured = {
      url,
      init,
      headers: new Headers(init.headers),
      body: await readBody(init),
    };
    requests.push(captured);
    return await responder(url, init);
  };
  const services: ProviderPipelineServices = { fetcherFor: () => fetcher };
  const outcome = await runPipeline(selectedPipeline, input, {
    services,
    ...(options.waitUntil === undefined ? {} : { waitUntil: options.waitUntil }),
    ...(options.traceSink === undefined ? {} : { traceSink: options.traceSink }),
  });
  return { outcome, requests };
};

const chatInput = (
  selectedModel: ProviderModelFacts,
  payload: Record<string, unknown>,
  inboundHeaders: readonly HeaderEntry[] = [['x-inbound', 'kept']],
): ProviderPipelineOpenAIChatCompletionsInput => ({
  'provider.model': selectedModel,
  'request.payload': payload as ProviderPipelineOpenAIChatCompletionsInput['request.payload'],
  'request.inboundHeaders': inboundHeaders,
});

const responsesInput = (
  selectedModel: ProviderModelFacts,
  payload: Record<string, unknown>,
  action: 'generate' | 'compact' = 'generate',
): ProviderPipelineOpenAIResponsesInput => ({
  'provider.model': selectedModel,
  'request.payload': payload as ProviderPipelineOpenAIResponsesInput['request.payload'],
  'request.inboundHeaders': [],
  'request.action': action,
});

const messagesInput = (
  selectedModel: ProviderModelFacts,
  payload: Record<string, unknown>,
  anthropicBeta: readonly string[] = ['future-beta'],
): ProviderPipelineAnthropicMessagesInput => ({
  'provider.model': selectedModel,
  'request.payload': payload as ProviderPipelineAnthropicMessagesInput['request.payload'],
  'request.inboundHeaders': [
    ['authorization', secret('Bearer inbound-token')],
    ['anthropic-beta', 'stale-beta'],
    ['x-inbound', 'kept'],
  ],
  'request.anthropicBeta': anthropicBeta,
});

const countTokensInput = (
  selectedModel: ProviderModelFacts,
  payload: Record<string, unknown>,
): ProviderPipelineAnthropicMessagesCountTokensInput => ({
  'provider.model': selectedModel,
  'request.payload': payload as ProviderPipelineAnthropicMessagesCountTokensInput['request.payload'],
  'request.inboundHeaders': [['x-inbound', 'kept']],
  'request.anthropicBeta': ['future-beta'],
});

const readJson = async (body: Parameters<typeof readManagedBytes>[0]): Promise<unknown> =>
  JSON.parse(new TextDecoder().decode(await readManagedBytes(body))) as unknown;

const drain = async (events: AsyncIterable<unknown>): Promise<void> => {
  for await (const _event of events) continue;
};

const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100 && !condition(); attempt++) await new Promise(resolve => setTimeout(resolve, 0));
  expect(condition()).toBe(true);
};

test('the provider exposes all four Kimi Code pipelines and the current instance contract', () => {
  const provider = createKimiCodeProvider(record());
  expect(provider.pipelines).toBeDefined();
  expect(provider.pipelines?.openaiChatCompletions?.name).toBe('kimi-code.openai-chat-completions');
  expect(provider.pipelines?.openaiResponses?.name).toBe('kimi-code.openai-responses');
  expect(provider.pipelines?.anthropicMessages?.name).toBe('kimi-code.anthropic-messages');
  expect(provider.pipelines?.anthropicMessagesCountTokens?.name).toBe('kimi-code.anthropic-messages-count-tokens');
  expect(Object.keys(provider.instance).sort()).toEqual(['getProvidedModels', 'runScheduledTask']);
});

test('chat routes a fast request to the fast lane, overwrites auth, and stamps the speed', async () => {
  const pipelines = createKimiCodePipelines(record(), config);
  const { outcome, requests } = await run(
    pipelines.openaiChatCompletions!,
    chatInput(dualLane, { service_tier: 'fast', messages: [], vendor_extension: 'kept' }, [
      ['authorization', secret('Bearer inbound-token')],
      ['x-inbound', 'kept'],
    ]),
    () => chatSse('default'),
  );

  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe('https://api.kimi.com/coding/v1/chat/completions');
  expect(requests[0]?.init.method).toBe('POST');
  expect(requests[0]?.headers.get('authorization')).toBe(`Bearer ${config.apiKey}`);
  expect(requests[0]?.headers.get('x-inbound')).toBe('kept');
  expect(requests[0]?.body).toEqual({ service_tier: 'priority', messages: [], vendor_extension: 'kept', model: 'k3.1-pro-highspeed', stream: true });
  expect(outcome).toMatchObject({ ok: true, modelKey: 'k3.1-pro-highspeed' });
  if (!outcome.ok) throw new Error('expected streaming outcome');
  const frames = [];
  for await (const frame of outcome.events) frames.push(frame);
  const event = frames.find(frame => frame.type === 'event');
  if (event?.type !== 'event') throw new Error('expected a chat event');
  expect(event.event.service_tier).toBe('priority');
});

test('responses generates through the selected fast lane and rejects compaction before dispatch', async () => {
  const pipelines = createKimiCodePipelines(record(), config);
  const generated = await run(
    pipelines.openaiResponses!,
    responsesInput(dualLane, { service_tier: 'priority', input: [], vendor_extension: 'kept' }),
    () => responsesSse('default'),
  );
  expect(generated.requests[0]?.url).toBe('https://api.kimi.com/coding/v1/responses');
  expect(generated.requests[0]?.headers.get('authorization')).toBe(`Bearer ${config.apiKey}`);
  expect(generated.requests[0]?.body).toEqual({ service_tier: 'priority', input: [], vendor_extension: 'kept', model: 'k3.1-pro-highspeed', stream: true });
  expect(generated.outcome).toMatchObject({ action: 'generate', ok: true, modelKey: 'k3.1-pro-highspeed' });
  if (generated.outcome.action !== 'generate' || !generated.outcome.ok) throw new Error('expected a generated response');
  const frames = [];
  for await (const frame of generated.outcome.events) frames.push(frame);
  const completed = frames.find(frame => frame.type === 'event' && frame.event.type === 'response.completed');
  if (completed?.type !== 'event' || completed.event.type !== 'response.completed') throw new Error('expected response.completed');
  expect(completed.event.response.service_tier).toBe('priority');

  await expect(runPipeline(
    pipelines.openaiResponses!,
    responsesInput(dualLane, { input: [] }, 'compact'),
    { services: { fetcherFor: () => async () => { throw new Error('must not dispatch'); } } },
  )).rejects.toThrow('Kimi Code does not expose a native Responses compaction endpoint');
});

test.each([
  ['fast', fastOnly, 'kimi-for-coding-highspeed', 'fast'],
  ['standard', dualLane, 'k3.1-pro', 'standard'],
] as const)('messages %s requests strip speed, preserve Secret headers, and stamp usage speed', async (speed, selectedModel, rawId, expectedSpeed) => {
  const pipelines = createKimiCodePipelines(record(), config);
  const inboundAuthorization = secret('Bearer inbound-token');
  let preservedSecret = false;
  const { outcome, requests } = await run(
    pipelines.anthropicMessages!,
    {
      ...messagesInput(selectedModel, { speed, max_tokens: 8, messages: [], vendor_extension: 'kept' }),
      'request.inboundHeaders': [
        ['authorization', inboundAuthorization],
        ['x-api-key', inboundAuthorization],
        ['x-inbound', 'kept'],
      ],
    },
    () => messagesSse('upstream-value'),
    {
      traceSink: {
        push: event => {
          if (event.k !== 'enter' || event.name !== 'up_kimi_code.http') return;
          const request = event.facts['request.http'] as { readonly headers: readonly HeaderEntry[] } | undefined;
          preservedSecret = request?.headers.some(([name, value]) => name === 'x-api-key' && value === inboundAuthorization) ?? false;
        },
      },
    },
  );
  expect(preservedSecret).toBe(true);
  expect(requests[0]?.url).toBe('https://api.kimi.com/coding/v1/messages');
  expect(requests[0]?.headers.get('authorization')).toBe(`Bearer ${config.apiKey}`);
  expect(requests[0]?.headers.get('anthropic-beta')).toBe('future-beta');
  expect(requests[0]?.headers.get('x-inbound')).toBe('kept');
  expect(requests[0]?.body).toEqual({ max_tokens: 8, messages: [], vendor_extension: 'kept', model: rawId, stream: true });
  expect(outcome).toMatchObject({ ok: true, modelKey: rawId });
  if (!outcome.ok) throw new Error('expected streaming outcome');
  const frames = [];
  for await (const frame of outcome.events) frames.push(frame);
  const start = frames.find(frame => frame.type === 'event' && frame.event.type === 'message_start');
  if (start?.type !== 'event' || start.event.type !== 'message_start') throw new Error('expected message_start');
  expect(start.event.message.usage.speed).toBe(expectedSpeed);
});

test.each([
  ['fast', fastOnly, 'kimi-for-coding-highspeed'],
  ['standard', dualLane, 'k3.1-pro'],
] as const)('count_tokens selects %s lane without forcing streaming or scheduling probes', async (speed, selectedModel, rawId) => {
  initProviderRepo(() => ({ recordUpstreamMetric: async () => {}, upstreams: { getById: async () => null, saveState: async () => {} } }));
  const pipelines = createKimiCodePipelines(record(), config);
  const background: Promise<unknown>[] = [];
  const probeUrls: string[] = [];
  const { outcome, requests } = await run(
    pipelines.anthropicMessagesCountTokens!,
    countTokensInput(selectedModel, { speed, max_tokens: 8, messages: [] }),
    url => {
      probeUrls.push(url);
      return new Response(JSON.stringify({ input_tokens: 7 }), { status: 429, headers: { 'content-type': 'application/json', 'x-upstream': 'kept' } });
    },
    { waitUntil: promise => { background.push(promise); } },
  );
  expect(requests[0]?.url).toBe('https://api.kimi.com/coding/v1/messages/count_tokens');
  expect(requests[0]?.headers.get('authorization')).toBe(`Bearer ${config.apiKey}`);
  expect(requests[0]?.headers.get('anthropic-beta')).toBe('future-beta');
  expect(requests[0]?.headers.get('x-inbound')).toBe('kept');
  expect(requests[0]?.body).toEqual({ max_tokens: 8, messages: [], model: rawId });
  expect(outcome.status).toBe(429);
  expect(outcome.headers.some(([name]) => name === 'x-upstream')).toBe(true);
  void background;
  expect(probeUrls).toEqual(['https://api.kimi.com/coding/v1/messages/count_tokens']);
  expect(await readJson(outcome.body)).toEqual({ input_tokens: 7 });
});

test('chat and responses return local 400s for a fast-only model without requesting fast mode', async () => {
  const pipelines = createKimiCodePipelines(record(), config);
  const chat = await run(pipelines.openaiChatCompletions!, chatInput(fastOnly, { service_tier: 'standard', messages: [] }), () => {
    throw new Error('must not dispatch');
  });
  const responses = await run(pipelines.openaiResponses!, responsesInput(fastOnly, { service_tier: 'standard', input: [] }), () => {
    throw new Error('must not dispatch');
  });
  for (const selection of [chat, responses]) expect(selection.requests).toHaveLength(0);
  expect(chat.outcome).toMatchObject({ ok: false, modelKey: 'kimi-for-coding-highspeed' });
  if (chat.outcome.ok) throw new Error('expected local validation failure');
  expect(chat.outcome.http.status).toBe(400);
  expect(await readJson(chat.outcome.http.body)).toMatchObject({ error: { type: 'invalid_request_error', message: expect.stringContaining('service_tier: "priority"') } });
  expect(responses.outcome).toMatchObject({ action: 'generate', ok: false, modelKey: 'kimi-for-coding-highspeed' });
  if (responses.outcome.action !== 'generate' || responses.outcome.ok) throw new Error('expected local validation failure');
  expect(responses.outcome.http.status).toBe(400);
  expect(await readJson(responses.outcome.http.body)).toMatchObject({ error: { type: 'invalid_request_error', message: expect.stringContaining('service_tier: "priority"') } });
});

test('messages rejects unsupported fast and missing fast selection locally', async () => {
  const pipelines = createKimiCodePipelines(record(), config);
  const unsupported = await run(
    pipelines.anthropicMessages!,
    messagesInput(standardOnly, { speed: 'fast', max_tokens: 8, messages: [] }),
    () => { throw new Error('must not dispatch'); },
  );
  expect(unsupported.requests).toHaveLength(0);
  expect(unsupported.outcome).toMatchObject({ ok: false, modelKey: 'k3' });
  if (unsupported.outcome.ok) throw new Error('expected unsupported fast failure');
  expect(unsupported.outcome.http.status).toBe(400);
  expect(await readJson(unsupported.outcome.http.body)).toMatchObject({
    type: 'error', error: { type: 'invalid_request_error', message: expect.stringContaining('does not support fast mode') },
  });

  const required = await run(
    pipelines.anthropicMessages!,
    messagesInput(fastOnly, { max_tokens: 8, messages: [] }),
    () => { throw new Error('must not dispatch'); },
  );
  expect(required.requests).toHaveLength(0);
  expect(required.outcome).toMatchObject({ ok: false, modelKey: 'kimi-for-coding-highspeed' });
  if (required.outcome.ok) throw new Error('expected fast-mode-required failure');
  expect(await readJson(required.outcome.http.body)).toMatchObject({
    type: 'error', error: { type: 'invalid_request_error', message: expect.stringContaining('speed: "fast"') },
  });
});

test('count_tokens returns the synthetic selection failure as a direct HTTP outcome', async () => {
  const pipelines = createKimiCodePipelines(record(), config);
  const { outcome, requests } = await run(
    pipelines.anthropicMessagesCountTokens!,
    countTokensInput(fastOnly, { max_tokens: 8, messages: [] }),
    () => { throw new Error('must not dispatch'); },
  );
  expect(requests).toHaveLength(0);
  expect(outcome.status).toBe(400);
  expect(outcome.modelKey).toBe('kimi-for-coding-highspeed');
  expect(await readJson(outcome.body)).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } });
});

test.each([
  [200, null, true],
  [200, recentState(), false],
  [429, recentState(), true],
  [403, recentState(), true],
] as const)('chat status %i with state %s refreshes usage: %s', async (status, state, expectedUsageRefresh) => {
  initProviderRepo(() => ({ recordUpstreamMetric: async () => {}, upstreams: { getById: async () => null, saveState: async () => {} } }));
  const pipelines = createKimiCodePipelines(record({ state }), config);
  const background: Promise<unknown>[] = [];
  const probeUrls: string[] = [];
  const { outcome } = await run(
    pipelines.openaiChatCompletions!,
    chatInput(dualLane, { messages: [] }),
    url => {
      probeUrls.push(url);
      if (url.endsWith('/usages')) return Response.json(usage());
      if (url.endsWith('/me')) return Response.json(profile);
      return status === 200
        ? chatSse()
        : new Response(JSON.stringify({ error: { message: 'upstream rejected', type: 'invalid_request_error' } }), {
            status,
            headers: { 'content-type': 'application/json', 'x-upstream': 'kept' },
          });
    },
    { waitUntil: promise => { background.push(promise); } },
  );
  void background;
  await waitFor(() => probeUrls.some(url => url.endsWith('/usages')) === expectedUsageRefresh);
  expect(probeUrls.filter(url => url.endsWith('/usages'))).toHaveLength(expectedUsageRefresh ? 1 : 0);
  if (status === 200) {
    if (!outcome.ok) throw new Error('expected success');
    await drain(outcome.events);
  } else {
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.http.status).toBe(status);
    expect(await readJson(outcome.http.body)).toMatchObject({ error: { message: 'upstream rejected' } });
  }
});

test.each(['responses', 'messages'] as const)('%s schedules an immediate usage refresh on 429 and 403', async protocol => {
  initProviderRepo(() => ({ recordUpstreamMetric: async () => {}, upstreams: { getById: async () => null, saveState: async () => {} } }));
  const pipelines = createKimiCodePipelines(record(), config);
  for (const status of [429, 403] as const) {
    const probeUrls: string[] = [];
    const background: Promise<unknown>[] = [];
    const result = protocol === 'responses'
      ? await run(
          pipelines.openaiResponses!,
          responsesInput(dualLane, { input: [] }),
          url => {
            probeUrls.push(url);
            if (url.endsWith('/usages')) return Response.json(usage());
            if (url.endsWith('/me')) return Response.json(profile);
            return Response.json({ error: { message: 'rejected', type: 'invalid_request_error' } }, { status });
          },
          { waitUntil: promise => { background.push(promise); } },
        )
      : await run(
          pipelines.anthropicMessages!,
          messagesInput(dualLane, { speed: 'standard', max_tokens: 8, messages: [] }),
          url => {
            probeUrls.push(url);
            if (url.endsWith('/usages')) return Response.json(usage());
            if (url.endsWith('/me')) return Response.json(profile);
            return Response.json({ type: 'error', error: { message: 'rejected', type: 'invalid_request_error' } }, { status });
          },
          { waitUntil: promise => { background.push(promise); } },
        );
    expect(result.outcome.ok).toBe(false);
    if (result.outcome.ok) throw new Error('expected upstream failure');
    expect(result.outcome.http.status).toBe(status);
    expect(await readJson(result.outcome.http.body)).toMatchObject({ error: { message: 'rejected' } });
    await waitFor(() => probeUrls.some(url => url.endsWith('/usages')));
    void background;
  }
});

test('the dump encoder never receives the raw Kimi Code credential', async () => {
  const pipelines = createKimiCodePipelines(record(), config);
  const encoder = createDumpEncoder({ detectRawSecretLeaks: true });
  encoder.registerSecretPlaintext(config.apiKey);
  const encoded: EncodedDumpEvent[] = [];
  const traceSink = {
    push: (event: RawRunEvent) => {
      encoded.push(...encoder.encodeBatch([event]));
    },
    registerSecretPlaintext: (plaintext: string) => encoder.registerSecretPlaintext(plaintext),
  };
  const { outcome } = await run(
    pipelines.anthropicMessages!,
    messagesInput(dualLane, { speed: 'standard', max_tokens: 8, messages: [] }),
    () => messagesSse('standard'),
    { traceSink },
  );
  if (!outcome.ok) throw new Error('expected streaming outcome');
  await drain(outcome.events);
  await vi.waitFor(() => {
    expect(encoded.at(-1)?.k).toBe('done');
  });
  const dump = JSON.stringify(encoded);
  expect(dump).not.toContain(config.apiKey);
  expect(dump).toContain('$secret');
});

test('the regional endpoint follows the upstream configuration', async () => {
  const pipelines = createKimiCodePipelines(record(), { ...config, region: 'overseas' });
  const { outcome, requests } = await run(
    pipelines.openaiChatCompletions!,
    chatInput(standardOnly, { messages: [] }),
    () => chatSse(),
  );
  expect(requests[0]?.url).toBe('https://api.kimi.ai/coding/v1/chat/completions');
  expect(outcome).toMatchObject({ ok: true, modelKey: 'k3' });
  if (!outcome.ok) throw new Error('expected success');
  await drain(outcome.events);
});

test('the selectors accept both ProviderModel and ProviderModelFacts', () => {
  const providerModel = stubProviderModel({ providerData: { standardModelId: 'raw' } });
  const facts = toProviderModelFacts(providerModel);
  expect(selectKimiCodeModel(providerModel, false)).toEqual({ modelId: 'raw', lane: 'standard' });
  expect(selectKimiCodeModel(facts, false)).toEqual({ modelId: 'raw', lane: 'standard' });
});
