import { expect, test, vi } from 'vitest';

import { CREDIT_BALANCE, USAGE_TOTALS } from './usage-fixture.ts';
import type { OllamaUpstreamConfig } from '../src/config.ts';
import { createOllamaPipelines } from '../src/pipelines.ts';
import { createOllamaProvider } from '../src/provider.ts';
import type { OllamaUpstreamState } from '../src/state.ts';
import { createDumpEncoder, isSecret, runPipeline, secret, type HeaderEntry, type Pipeline, type RawRunEvent, type RunTraceSink } from '@floway-dev/pipeline';
import {
  initProviderRepo,
  isReplayableBody,
  readManagedBytes,
  toProviderModelFacts,
  type Fetcher,
  type FetchInit,
  type ProviderModelFacts,
  type ProviderPipelineAnthropicMessagesCountTokensInput,
  type ProviderPipelineAnthropicMessagesInput,
  type ProviderPipelineDecisionInput,
  type ProviderPipelineOpenAIAudioTranscriptionsInput,
  type ProviderPipelineOpenAIChatCompletionsInput,
  type ProviderPipelineOpenAICompletionsInput,
  type ProviderPipelineOpenAIEmbeddingsInput,
  type ProviderPipelineOpenAIResponsesInput,
  type ProviderPipelineServices,
  type UpstreamRecord,
} from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

const encoder = new TextEncoder();

const staleState: OllamaUpstreamState = {
  usageProbe: { attemptedAt: 0, observation: null, error: null },
  account: { fetchedAt: 0, plan: 'free', name: 'operator', email: null },
};

const config = (overrides: Partial<OllamaUpstreamConfig> = {}): OllamaUpstreamConfig => ({
  baseUrl: 'https://ollama.example/api?tenant=dump-query-secret',
  apiKey: 'ollama-test-api-secret',
  cloudUsage: false,
  models: [],
  ...overrides,
});

const record = (upstreamConfig: OllamaUpstreamConfig, overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: 'up_ollama_pipeline',
  kind: 'ollama',
  name: 'Ollama',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  config: upstreamConfig,
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
  ...overrides,
});

const model = (): ProviderModelFacts => toProviderModelFacts(stubProviderModel({
  id: 'public-model',
  upstreamModelId: 'raw-model',
  providerData: 'gpt-oss:120b',
  endpoints: {
    openaiCompletions: {},
    openaiChatCompletions: {},
    openaiResponses: {},
    anthropicMessages: {},
    openaiEmbeddings: {},
    openaiAudioTranscriptions: {},
    decision: {},
  },
  decisionTarget: { protocol: 'typesafe-systemone' },
}));

interface CapturedRequest {
  readonly url: string;
  readonly init: FetchInit;
  readonly headers: Headers;
  readonly body: FetchInit['body'];
}

const readBody = async (init: FetchInit): Promise<unknown> => {
  if (init.body === null || init.body === undefined) return undefined;
  if (isReplayableBody(init.body)) return await new Response(init.body.open()).text();
  return await new Response(init.body as BodyInit).text();
};

interface RunOptions {
  readonly waitUntil?: (promise: Promise<unknown>) => void;
  readonly traceSink?: RunTraceSink;
}

const run = async <In extends object, Out>(
  selectedPipeline: Pipeline<In, Out, ProviderPipelineServices>,
  input: In,
  responder: (url: string, init: FetchInit) => Response | Promise<Response>,
  options: RunOptions = {},
): Promise<{ readonly outcome: Out; readonly requests: readonly CapturedRequest[] }> => {
  const requests: CapturedRequest[] = [];
  const fetcher: Fetcher = async (url, init) => {
    requests.push({ url, init, headers: new Headers(init.headers), body: init.body });
    return await responder(url, init);
  };
  const outcome = await runPipeline(selectedPipeline, input, {
    services: { fetcherFor: () => fetcher },
    ...(options.waitUntil === undefined ? {} : { waitUntil: options.waitUntil }),
    ...(options.traceSink === undefined ? {} : { traceSink: options.traceSink }),
  });
  return { outcome, requests };
};

const chat = (
  payload: Record<string, unknown>,
  inboundHeaders: readonly HeaderEntry[] = [],
): ProviderPipelineOpenAIChatCompletionsInput => ({
  'provider.model': model(),
  'request.payload': payload as ProviderPipelineOpenAIChatCompletionsInput['request.payload'],
  'request.inboundHeaders': inboundHeaders,
});

const messages = (
  payload: Record<string, unknown>,
  inboundHeaders: readonly HeaderEntry[] = [],
  beta: readonly string[] = [],
): ProviderPipelineAnthropicMessagesInput => ({
  'provider.model': model(),
  'request.payload': payload as ProviderPipelineAnthropicMessagesInput['request.payload'],
  'request.inboundHeaders': inboundHeaders,
  'request.anthropicBeta': beta,
});

const responses = (
  payload: Record<string, unknown>,
  action: 'generate' | 'compact' = 'generate',
): ProviderPipelineOpenAIResponsesInput => ({
  'provider.model': model(),
  'request.payload': payload as ProviderPipelineOpenAIResponsesInput['request.payload'],
  'request.inboundHeaders': [],
  'request.action': action,
});

const countTokens = (payload: Record<string, unknown>): ProviderPipelineAnthropicMessagesCountTokensInput => ({
  'provider.model': model(),
  'request.payload': payload as ProviderPipelineAnthropicMessagesCountTokensInput['request.payload'],
  'request.inboundHeaders': [],
  'request.anthropicBeta': ['context-1m'],
});

const completions = (payload: Record<string, unknown>): ProviderPipelineOpenAICompletionsInput => ({
  'provider.model': model(),
  'request.payload': payload as ProviderPipelineOpenAICompletionsInput['request.payload'],
  'request.inboundHeaders': [],
});

const embeddings = (payload: Record<string, unknown>): ProviderPipelineOpenAIEmbeddingsInput => ({
  'provider.model': model(),
  'request.payload': payload as ProviderPipelineOpenAIEmbeddingsInput['request.payload'],
  'request.inboundHeaders': [],
});

const audio = (payload: ProviderPipelineOpenAIAudioTranscriptionsInput['request.payload']): ProviderPipelineOpenAIAudioTranscriptionsInput => ({
  'provider.model': model(),
  'request.payload': payload,
  'request.inboundHeaders': [],
});

const decision = (payload: ProviderPipelineDecisionInput['request.payload']): ProviderPipelineDecisionInput => ({
  'provider.model': model(),
  'request.payload': payload,
  'request.inboundHeaders': [],
});

const readJson = async (body: Parameters<typeof readManagedBytes>[0]): Promise<unknown> =>
  JSON.parse(new TextDecoder().decode(await readManagedBytes(body))) as unknown;

const drain = async (events: AsyncIterable<unknown>): Promise<void> => {
  for await (const _event of events) continue;
};

test('the provider exposes every supported Ollama pipeline and the current instance contract', () => {
  const provider = createOllamaProvider(record(config()));
  expect(provider.pipelines).toBeDefined();
  expect(Object.keys(provider.pipelines ?? {})).toEqual([
    'openaiCompletions', 'openaiChatCompletions', 'openaiResponses', 'anthropicMessages',
    'anthropicMessagesCountTokens', 'openaiEmbeddings', 'openaiAudioTranscriptions', 'decision',
  ]);
  expect(Object.keys(provider.instance).sort()).toEqual(['getProvidedModels', 'runScheduledTask']);
});

test('chat renames the output cap without mutating frozen input and consumes an SSE response', async () => {
  const pipelines = createOllamaPipelines(record(config()), config(), staleState);
  const inboundSecret = secret('Bearer inbound');
  let preservedInboundSecret = false;
  const payload = Object.freeze({ messages: Object.freeze([]), max_completion_tokens: 0, vendor_extension: { kept: true } });
  const sse = 'data: {"id":"chat","object":"chat.completion.chunk","created":1,"model":"gpt-oss:120b","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: [DONE]\n\n';
  const { outcome, requests } = await run(pipelines.openaiChatCompletions!, chat(payload, [['X-Inbound', inboundSecret], ['authorization', secret('Bearer inbound')]]), () => new Response(sse, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'x-upstream': 'kept' },
  }), {
    traceSink: {
      push: event => {
        if (event.k !== 'enter' || event.name !== 'up_ollama_pipeline.http') return;
        const request = event.facts['request.http'] as { readonly headers: readonly HeaderEntry[] } | undefined;
        preservedInboundSecret = request?.headers.some(([, value]) => value === inboundSecret) ?? false;
      },
    },
  });

  expect(payload).toEqual({ messages: [], max_completion_tokens: 0, vendor_extension: { kept: true } });
  expect(requests[0]?.url).toBe('https://ollama.example/api/v1/chat/completions?tenant=dump-query-secret');
  expect(requests[0]?.headers.get('authorization')).toBe('Bearer inbound');
  expect(requests[0]?.headers.get('x-inbound')).toBe('Bearer inbound');
  expect(JSON.parse(await readBody(requests[0]!.init) as string)).toEqual({ messages: [], vendor_extension: { kept: true }, max_tokens: 0, stream: true, model: 'gpt-oss:120b' });
  expect(outcome).toMatchObject({ ok: true, modelKey: 'gpt-oss:120b', http: { status: 200 } });
  expect(outcome.http.headers.some(([name]) => name === 'x-upstream')).toBe(true);
  if (!outcome.ok) throw new Error('expected a successful chat stream');
  const events = [...await collectEvents(outcome.events)];
  expect(JSON.stringify(events)).toContain('hello');
  expect(preservedInboundSecret).toBe(true);
  expect(isSecret(inboundSecret)).toBe(true);
});

test('completions and embeddings use their exact paths and model ids', async () => {
  const pipelines = createOllamaPipelines(record(config()), config(), staleState);
  const completion = await run(
    pipelines.openaiCompletions!,
    completions({ prompt: 'hello', vendor_extension: 'kept' }),
    () => Response.json({ ok: true }),
  );
  expect(completion.outcome.status).toBe(200);
  expect(completion.requests[0]?.url).toBe('https://ollama.example/api/v1/completions?tenant=dump-query-secret');
  expect(JSON.parse(await readBody(completion.requests[0]!.init) as string)).toEqual({ prompt: 'hello', vendor_extension: 'kept', model: 'gpt-oss:120b' });
  await readManagedBytes(completion.outcome.body);

  const embedding = await run(
    pipelines.openaiEmbeddings!,
    embeddings({ input: ['hello'] }),
    () => Response.json({ ok: true }),
  );
  expect(embedding.outcome.status).toBe(200);
  expect(embedding.requests[0]?.url).toBe('https://ollama.example/api/v1/embeddings?tenant=dump-query-secret');
  expect(JSON.parse(await readBody(embedding.requests[0]!.init) as string)).toEqual({ input: ['hello'], model: 'gpt-oss:120b' });
  await readManagedBytes(embedding.outcome.body);
});

test('responses generate parses SSE while compact reads only 2xx bytes and preserves non-2xx bodies', async () => {
  const pipelines = createOllamaPipelines(record(config()), config(), staleState);
  const sse = [
    'event: response.created',
    `data: ${JSON.stringify({ type: 'response.created', response: { id: 'r', object: 'response', model: 'gpt-oss:120b', status: 'in_progress', output: [], error: null, incomplete_details: null } })}`,
    '', 'event: response.completed',
    `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'r', object: 'response', model: 'gpt-oss:120b', status: 'completed', output: [{ type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }], error: null, incomplete_details: null } })}`,
    '',
  ].join('\n');
  const generated = await run(pipelines.openaiResponses!, responses({ input: [] }, 'generate'), () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }));
  expect(generated.requests[0]?.url).toBe('https://ollama.example/api/v1/responses?tenant=dump-query-secret');
  expect(JSON.parse(await readBody(generated.requests[0]!.init) as string)).toEqual({ input: [], stream: true, model: 'gpt-oss:120b' });
  expect(generated.outcome).toMatchObject({ action: 'generate', ok: true, modelKey: 'gpt-oss:120b' });
  if (generated.outcome.action !== 'generate' || !generated.outcome.ok) throw new Error('expected generated responses stream');
  await drain(generated.outcome.events);

  const compacted = await run(pipelines.openaiResponses!, responses({ input: [], tools: [{ type: 'function', name: 'ignored' }] }, 'compact'), () => Response.json({ id: 'compact', object: 'response.compaction', output: [] }));
  expect(compacted.requests[0]?.url).toBe('https://ollama.example/api/v1/responses/compact?tenant=dump-query-secret');
  expect(JSON.parse(await readBody(compacted.requests[0]!.init) as string)).toEqual({ input: [], model: 'gpt-oss:120b' });
  expect(compacted.outcome).toMatchObject({ action: 'compact', ok: true, modelKey: 'gpt-oss:120b', result: { id: 'compact' }, http: { status: 200 } });

  const failed = await run(pipelines.openaiResponses!, responses({ input: [] }, 'compact'), () => new Response('rejected', { status: 429, headers: { 'x-upstream': 'kept' } }));
  expect(failed.outcome).toMatchObject({ action: 'compact', ok: false, modelKey: 'gpt-oss:120b', http: { status: 429 } });
  if (failed.outcome.action !== 'compact' || failed.outcome.ok) throw new Error('expected failed compaction');
  expect(new TextDecoder().decode(await readManagedBytes(failed.outcome.http.body))).toBe('rejected');
});

test('messages and count_tokens merge inbound and typed Anthropic headers, with probes only on messages', async () => {
  initProviderRepo(() => ({ recordUpstreamMetric: async () => {}, upstreams: { getById: async () => null, saveState: async () => {} } }));
  const pipelines = createOllamaPipelines(record(config()), config(), staleState);
  const inboundSecret = secret('Bearer inbound');
  const messageSse = 'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"gpt-oss:120b","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  const message = await run(pipelines.anthropicMessages!, messages({ max_tokens: 8, messages: [] }, [['authorization', inboundSecret], ['anthropic-beta', 'stale']], ['context-1m']), () => new Response(messageSse, { headers: { 'content-type': 'text/event-stream' } }));
  expect(message.requests[0]?.url).toBe('https://ollama.example/api/v1/messages?tenant=dump-query-secret');
  expect(message.requests[0]?.headers.get('anthropic-beta')).toBe('context-1m');
  expect(JSON.parse(await readBody(message.requests[0]!.init) as string)).toEqual({ max_tokens: 8, messages: [], stream: true, model: 'gpt-oss:120b' });
  expect(message.outcome).toMatchObject({ ok: true, modelKey: 'gpt-oss:120b' });
  if (!message.outcome.ok) throw new Error('expected message stream');
  await drain(message.outcome.events);

  const count = await run(pipelines.anthropicMessagesCountTokens!, countTokens({ max_tokens: 8, messages: [] }), () => Response.json({ input_tokens: 7 }, { status: 429 }));
  expect(count.requests[0]?.url).toBe('https://ollama.example/api/v1/messages/count_tokens?tenant=dump-query-secret');
  expect(count.requests[0]?.headers.get('anthropic-beta')).toBe('context-1m');
  expect(count.outcome.status).toBe(429);
  expect(await readJson(count.outcome.body)).toEqual({ input_tokens: 7 });
});

test('audio transcription sends pure-data multipart and replaces the client model, while decision uses its target path without probes', async () => {
  const pipelines = createOllamaPipelines(record(config()), config(), staleState);
  const audioResult = await run(pipelines.openaiAudioTranscriptions!, audio({
    entries: [
      { kind: 'text', name: 'model', value: 'client-model' },
      { kind: 'file', name: 'file', bytes: encoder.encode('RIFF'), filename: 'clip.wav', contentType: 'audio/wav' },
    ],
  }), () => Response.json({ text: 'hello' }));
  expect(audioResult.requests[0]?.url).toBe('https://ollama.example/api/v1/audio/transcriptions?tenant=dump-query-secret');
  expect(audioResult.requests[0]?.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=----FlowayFormBoundary/);
  const audioBody = await readBody(audioResult.requests[0]!.init) as string;
  expect(audioBody).toContain('gpt-oss:120b');
  expect(audioBody).not.toContain('client-model');
  expect(audioBody).toContain('filename="clip.wav"');

  const decisionTarget = model().decisionTarget;
  const decisionResult = await run(pipelines.decision!, decision({
    sourceProtocol: 'typesafe-systemone',
    raw: { model: 'client', state: { kind: 'text', value: 'hello' }, questions: [] },
    state: { kind: 'text', value: 'hello' },
    questions: [],
  }), () => Response.json({ answers: {} }));
  expect(decisionTarget).toBeDefined();
  expect(decisionResult.requests[0]?.url).toBe('https://ollama.example/api/v1/systemone?tenant=dump-query-secret');
  expect(decisionResult.outcome).toMatchObject({ target: decisionTarget, modelKey: 'gpt-oss:120b', http: { status: 200 } });
  expect(JSON.parse(await readBody(decisionResult.requests[0]!.init) as string)).toEqual({ model: 'gpt-oss:120b', state: { kind: 'text', value: 'hello' }, questions: [] });
});

test('non-2xx streaming responses preserve status, headers and a readable body without a leak error', async () => {
  const pipelines = createOllamaPipelines(record(config()), config(), staleState);
  const failed = await run(pipelines.openaiChatCompletions!, chat({ messages: [] }), () => new Response('rate limited', { status: 429, headers: { 'x-upstream': 'kept' } }));
  expect(failed.outcome).toMatchObject({ ok: false, modelKey: 'gpt-oss:120b', http: { status: 429 } });
  if (failed.outcome.ok) throw new Error('expected failed chat stream');
  expect(failed.outcome.http.headers.some(([name]) => name === 'x-upstream')).toBe(true);
  expect(new TextDecoder().decode(await readManagedBytes(failed.outcome.http.body))).toBe('rate limited');
});

test('inference arms usage, balance and account probes while count_tokens and decision do not', async () => {
  initProviderRepo(() => ({
    recordUpstreamMetric: async () => {},
    upstreams: {
      getById: async () => null,
      saveState: async () => {},
    },
  }));
  const probes: string[] = [];
  const fetcher: Fetcher = async url => {
    const pathname = new URL(url).pathname;
    probes.push(pathname);
    if (pathname === '/api/usage') return Response.json(USAGE_TOTALS);
    if (pathname === '/api/balance') return Response.json(CREDIT_BALANCE);
    if (pathname === '/api/me') return Response.json({ Plan: 'free', Name: 'operator', Email: null });
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  const cloudConfig = config({ baseUrl: 'https://ollama.example', cloudUsage: true });
  const pipelines = createOllamaPipelines(record(cloudConfig), cloudConfig, staleState);
  const pending: Promise<unknown>[] = [];
  const waitUntil = (promise: Promise<unknown>): void => {
    pending.push(promise);
    void promise.catch(() => undefined);
  };
  const input: ProviderPipelineOpenAIChatCompletionsInput = {
    ...chat({ messages: [] }),
    'request.inboundHeaders': [],
  };
  const services: ProviderPipelineServices = { fetcherFor: () => fetcher };
  const chatOutcome = await runPipeline(pipelines.openaiChatCompletions!, input, { services, waitUntil });
  if (!chatOutcome.ok) throw new Error('expected chat stream');
  await drain(chatOutcome.events);
  await vi.waitFor(() => {
    expect(probes.sort()).toEqual(['/api/balance', '/api/me', '/api/usage', '/v1/chat/completions']);
  });
  await Promise.all(pending);

  probes.length = 0;
  const countOutcome = await runPipeline(pipelines.anthropicMessagesCountTokens!, countTokens({ max_tokens: 8, messages: [] }), { services, waitUntil });
  await readManagedBytes(countOutcome.body);

  const decisionOutcome = await runPipeline(pipelines.decision!, decision({
    sourceProtocol: 'typesafe-systemone',
    raw: { model: 'client', state: { kind: 'text', value: 'hello' }, questions: [] },
    state: { kind: 'text', value: 'hello' },
    questions: [],
  }), { services, waitUntil });
  await readManagedBytes(decisionOutcome.http.body);
  expect(probes.sort()).toEqual(['/v1/messages/count_tokens', '/v1/systemone']);
});

test('the dump encoder redacts the API key and base URL query credentials', async () => {
  const pipelines = createOllamaPipelines(record(config()), config(), staleState);
  const dumpEncoder = createDumpEncoder({ detectRawSecretLeaks: true });
  dumpEncoder.registerSecretPlaintext(config().apiKey!);
  dumpEncoder.registerSecretPlaintext('dump-query-secret');
  const encoded: ReturnType<typeof dumpEncoder.encodeBatch> = [];
  const traceSink = {
    push: (event: RawRunEvent) => {
      encoded.push(...dumpEncoder.encodeBatch([event]));
    },
    registerSecretPlaintext: (value: string) => dumpEncoder.registerSecretPlaintext(value),
  };
  const { outcome } = await run(pipelines.openaiChatCompletions!, chat({ messages: [] }), () => new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }), { traceSink });
  if (!outcome.ok) throw new Error('expected streaming outcome');
  await drain(outcome.events);
  await vi.waitFor(() => {
    expect(encoded.at(-1)?.k).toBe('done');
  });
  const dump = JSON.stringify(encoded);
  expect(dump).not.toContain('ollama-test-api-secret');
  expect(dump).not.toContain('dump-query-secret');
  expect(dump).toContain('$secret');

  const fetcher = async (_url: string, init: FetchInit): Promise<Response> => {
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer ollama-test-api-secret');
    return Response.json({ ok: true });
  };
  const embedding = await runPipeline(
    createOllamaPipelines(record(config({ baseUrl: 'https://ollama.example', cloudUsage: false })), config({ baseUrl: 'https://ollama.example', cloudUsage: false }), staleState).openaiEmbeddings!,
    embeddings({ input: 'hello' }),
    { services: { fetcherFor: () => fetcher } },
  );
  expect(embedding.status).toBe(200);
});

async function collectEvents<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}
