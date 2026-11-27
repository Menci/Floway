import { expect, it, vi } from 'vitest';

import type { CustomUpstreamConfig } from '../src/config.ts';
import { customPipelines } from '../src/index.ts';
import { customHeaders } from '../src/pipelines/http.ts';
import { HttpTransportError, type FetchInit, type Fetcher } from '@floway-dev/http';
import { asEntry, run } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsAssistantMessageEx } from '@floway-dev/protocols/openai-chat-completions';
import type { UpstreamHttpServices, UpstreamOperation, UpstreamPipeline, UpstreamRequest, UpstreamRequestFacts } from '@floway-dev/upstream';

const config: CustomUpstreamConfig = {
  apiKey: 'wire-key',
  baseUrl: 'https://custom.test/prefix/',
  endpoints: {},
  pathOverrides: {
    '/messages': '/anthropic',
    '/responses': '/custom-responses',
    '/v1beta/models': '/gemini/models',
    '/audio/speech': '/synthesize',
  },
  ingressHeadersRules: [{ key: 'x-test-route', value: 'provider-route' }],
  modelsFetch: { enabled: false, authStyle: 'bearer' },
};

const upstream = { id: 'custom-test', kind: 'custom', name: 'Custom', config } as const;
const model: UpstreamRequestFacts['model'] = {
  id: 'public-model',
  upstreamModelId: 'native-model',
  kind: 'chat',
  opaqueBlobCompatibilityScope: { bindToUpstream: true },
  endpoints: {},
  enabledFlags: [],
  limits: {},
};
const base: Pick<UpstreamRequestFacts, 'http' | 'upstream' | 'model'> = {
  upstream,
  model,
  http: {
    method: 'POST',
    url: 'https://floway.test/original',
    headers: [],
    body: new Uint8Array([0]),
  },
};

const runWith = <Operation extends UpstreamOperation>(
  pipeline: UpstreamPipeline<Operation, UpstreamHttpServices>,
  request: UpstreamRequest<Operation>,
  fetcher: Fetcher,
  signal = new AbortController().signal,
) => {
  const background: Promise<unknown>[] = [];
  const execution = run(asEntry(pipeline), request, {
    services: {
      fetcher(id) {
        expect(id).toBe(upstream.id);
        return fetcher;
      },
    },
    signal,
    waitUntil: work => { background.push(work); },
  });
  return { execution, background };
};

const jsonBody = ({ body }: FetchInit): unknown => {
  if (typeof body !== 'string') throw new Error('Expected serialized JSON');
  return JSON.parse(body);
};

const multipartBody = async ({ body, headers }: FetchInit): Promise<FormData> => {
  if (!(body instanceof Uint8Array)) throw new Error('Expected serialized multipart bytes');
  const contentType = new Headers(headers).get('content-type');
  expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
  return await new Response(new Uint8Array(body), { headers: { 'content-type': contentType! } }).formData();
};

const alphaPayload = { model: 'public-model', query: 'example' };
const messagesPayload = { model: 'public-model', messages: [] };
const completionsPayload = { model: 'public-model', prompt: 'example' };
const responsesPayload = { model: 'public-model', input: [] };
const compactPayload = {
  ...responsesPayload,
  store: false,
  service_tier: 'operator-tier',
  prompt_cache_options: null,
  temperature: 0.6,
  tools: [{ type: 'function', name: 'generate_only' }],
};
const geminiModel = { ...model, upstreamModelId: 'models/native/model' };
const geminiPayload = { contents: [{ parts: [{ text: 'prompt' }] }] };
const geminiCount = { generateContentRequest: { ...geminiPayload, model: 'public-model', systemInstruction: { parts: [{ text: 'system' }] } } };
const speechPayload = { model: 'public-model', input: 'read this', voice: 'upstream-voice', response_format: 'upstream-format', stream_format: 'upstream-stream-format' };
const imagePayload = { model: 'public-model', prompt: 'draw this', quality: 'upstream-quality', size: 'upstream-size' };
const imageFile = { name: 'image.png', mediaType: 'image/png', bytes: new Uint8Array([1, 2, 3]) };
const audioFile = { name: 'voice.wav', mediaType: 'audio/wav', bytes: new Uint8Array([4, 5, 6]) };
const transcriptions = { entries: [{ name: 'model', value: 'public-model' }, { name: 'file', value: audioFile }, { name: 'response_format', value: 'vendor-format' }, { name: 'timestamp_granularities[]', value: 'word' }, { name: 'timestamp_granularities[]', value: 'segment' }] };
const imagesEdits: UpstreamRequestFacts['openaiImagesEdits'] = { images: [{ type: 'upload', file: imageFile }], parameters: { prompt: 'edit this', quality: 'upstream-quality' } };
const rerank: UpstreamRequestFacts['rerank'] = { sourceProtocol: 'cohere-v2', raw: { model: 'public-model', query: 'query', documents: ['document'], extra: 'retained' }, query: 'query', documents: ['document'] };
const decision: UpstreamRequestFacts['decision'] = { sourceProtocol: 'openai-decisions', raw: { model: 'public-model', state: 'evidence', questions: [], extra: 'retained' }, state: { kind: 'text', value: 'evidence' }, questions: [] };
const rerankModel: UpstreamRequestFacts['model'] = { ...model, rerankTarget: { protocol: 'cohere-v2', path: '/ranking' } };
const decisionModel: UpstreamRequestFacts['model'] = { ...model, decisionTarget: { protocol: 'openai-decisions', path: '/decide' } };

const checkDial = async <Operation extends UpstreamOperation>(
  operation: Operation,
  pipeline: UpstreamPipeline<Operation, UpstreamHttpServices>,
  request: UpstreamRequest<Operation>,
  path: string,
  inspect: (init: FetchInit) => void | Promise<void>,
) => {
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    expect(url).toBe(`https://custom.test/prefix${path}`);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('x-test-route')).toBe('provider-route');
    await inspect(init);
    return Response.json({ error: { message: 'try another provider' } }, { status: 429 });
  });
  const { execution } = runWith(pipeline, request, fetcher);
  expect(await execution.result).toMatchObject({
    http: { status: 429, body: null },
    [operation]: { kind: 'error', source: 'upstream', error: { error: { message: 'try another provider' } } },
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
};

const verifyJson = (body: object, auth: string = 'authorization', value: string = 'Bearer wire-key') => (init: FetchInit) => {
  expect(new Headers(init.headers).get(auth)).toBe(value);
  expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  expect(jsonBody(init)).toEqual(body);
};

it('dials every JSON operation at its typed endpoint with native model and protocol authentication', async () => {
  await Promise.all([
    checkDial('alphaSearch', customPipelines.alphaSearch, { ...base, alphaSearch: alphaPayload }, '/v1/alpha/search', verifyJson({ ...alphaPayload, model: 'native-model' })),
    checkDial('anthropicMessages', customPipelines.anthropicMessages, { ...base, anthropicMessages: { ...messagesPayload, max_tokens: 32 } }, '/anthropic', verifyJson({ ...messagesPayload, max_tokens: 32, model: 'native-model', stream: true }, 'x-api-key', 'wire-key')),
    checkDial('anthropicMessagesCountTokens', customPipelines.anthropicMessagesCountTokens, { ...base, anthropicMessagesCountTokens: messagesPayload }, '/anthropic/count_tokens', verifyJson({ ...messagesPayload, model: 'native-model' }, 'x-api-key', 'wire-key')),
    checkDial('decision', customPipelines.decision, { ...base, model: decisionModel, decision }, '/decide', verifyJson({ ...decision.raw, model: 'native-model' })),
    checkDial('geminiGenerateContent', customPipelines.geminiGenerateContent, { ...base, model: geminiModel, geminiGenerateContent: geminiPayload }, '/gemini/models/native%2Fmodel:streamGenerateContent?alt=sse', verifyJson(geminiPayload, 'x-goog-api-key', 'wire-key')),
    checkDial('geminiGenerateContentCountTokens', customPipelines.geminiGenerateContentCountTokens, { ...base, model: geminiModel, geminiGenerateContentCountTokens: geminiCount }, '/gemini/models/native%2Fmodel:countTokens', verifyJson({ generateContentRequest: { ...geminiCount.generateContentRequest, model: 'models/native/model' } }, 'x-goog-api-key', 'wire-key')),
    checkDial('openaiAudioSpeech', customPipelines.openaiAudioSpeech, { ...base, openaiAudioSpeech: speechPayload }, '/synthesize', verifyJson({ ...speechPayload, model: 'native-model' })),
    checkDial('openaiChatCompletions', customPipelines.openaiChatCompletions, { ...base, openaiChatCompletions: messagesPayload }, '/v1/chat/completions', verifyJson({ ...messagesPayload, model: 'native-model', stream: true })),
    checkDial('openaiCompletions', customPipelines.openaiCompletions, { ...base, openaiCompletions: completionsPayload }, '/v1/completions', verifyJson({ ...completionsPayload, model: 'native-model' })),
    checkDial('openaiEmbeddings', customPipelines.openaiEmbeddings, { ...base, openaiEmbeddings: { model: 'public-model', input: 'example' } }, '/v1/embeddings', verifyJson({ model: 'native-model', input: 'example' })),
    checkDial('openaiImagesGenerations', customPipelines.openaiImagesGenerations, { ...base, openaiImagesGenerations: imagePayload }, '/v1/images/generations', verifyJson({ ...imagePayload, model: 'native-model' })),
    checkDial('openaiResponses', customPipelines.openaiResponses, { ...base, openaiResponses: responsesPayload }, '/custom-responses', verifyJson({ ...responsesPayload, model: 'native-model', stream: true })),
    checkDial('openaiResponsesCompact', customPipelines.openaiResponsesCompact, { ...base, openaiResponsesCompact: compactPayload }, '/custom-responses/compact', verifyJson({ ...responsesPayload, service_tier: 'operator-tier', prompt_cache_options: null, model: 'native-model' })),
    checkDial('rerank', customPipelines.rerank, { ...base, model: rerankModel, rerank }, '/ranking', verifyJson({ ...rerank.raw, model: 'native-model' })),
  ]);
});

it('rebuilds multipart with the native model, original file bytes, and ordered repeated fields', async () => {
  await checkDial('openaiImagesEdits', customPipelines.openaiImagesEdits, { ...base, openaiImagesEdits: imagesEdits }, '/v1/images/edits', async init => {
    const form = await multipartBody(init);
    expect(form.get('model')).toBe('native-model');
    expect(form.get('quality')).toBe('upstream-quality');
    const image = form.get('image');
    if (!(image instanceof File)) throw new Error('Expected an uploaded image');
    expect([image.name, image.type, new Uint8Array(await image.arrayBuffer())]).toEqual([imageFile.name, imageFile.mediaType, imageFile.bytes]);
  });
  await checkDial('openaiAudioTranscriptions', customPipelines.openaiAudioTranscriptions, { ...base, openaiAudioTranscriptions: transcriptions }, '/v1/audio/transcriptions', async init => {
    const form = await multipartBody(init);
    expect(form.get('model')).toBe('native-model');
    expect(form.get('response_format')).toBe('vendor-format');
    expect(form.getAll('timestamp_granularities[]')).toEqual(['word', 'segment']);
    const audio = form.get('file');
    if (!(audio instanceof File)) throw new Error('Expected uploaded audio');
    expect([audio.name, audio.type, new Uint8Array(await audio.arrayBuffer())]).toEqual([audioFile.name, audioFile.mediaType, audioFile.bytes]);
  });
});

it('uses the configured alpha search path and sends no credentials for an empty API key', async () => {
  const anonymous = { ...upstream, config: { ...config, apiKey: '', pathOverrides: { ...config.pathOverrides, '/alpha/search': '/api/search' } } };
  const inspect = (init: FetchInit) => {
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-api-key')).toBeNull();
    expect(headers.get('anthropic-version')).toBeNull();
  };
  await checkDial('alphaSearch', customPipelines.alphaSearch, { ...base, upstream: anonymous, alphaSearch: alphaPayload }, '/api/search', inspect);
  await checkDial('anthropicMessages', customPipelines.anthropicMessages, {
    ...base, upstream: anonymous, anthropicMessages: { ...messagesPayload, max_tokens: 32 },
  }, '/anthropic', inspect);
});

it('preserves query keys and fragments while adding derived actions to the upstream pathname', async () => {
  const configured = {
    ...upstream,
    config: {
      ...config,
      pathOverrides: {
        '/messages': '/provider/messages?tenant=anthropic#routing',
        '/responses': '/provider/responses?tenant=openai&tag=a&tag=b',
        '/v1beta/models': '/provider/models?tenant=google&alt=json&tag=a&tag=b',
      },
    },
  };
  await checkDial('anthropicMessages', customPipelines.anthropicMessages, {
    ...base, upstream: configured, anthropicMessages: { ...messagesPayload, max_tokens: 32 },
  }, '/provider/messages?tenant=anthropic#routing', verifyJson({ ...messagesPayload, max_tokens: 32, model: 'native-model', stream: true }, 'x-api-key', 'wire-key'));
  await checkDial('anthropicMessagesCountTokens', customPipelines.anthropicMessagesCountTokens, {
    ...base, upstream: configured, anthropicMessagesCountTokens: messagesPayload,
  }, '/provider/messages/count_tokens?tenant=anthropic#routing', verifyJson({ ...messagesPayload, model: 'native-model' }, 'x-api-key', 'wire-key'));
  await checkDial('openaiResponsesCompact', customPipelines.openaiResponsesCompact, {
    ...base, upstream: configured, openaiResponsesCompact: responsesPayload,
  }, '/provider/responses/compact?tenant=openai&tag=a&tag=b', verifyJson({ ...responsesPayload, model: 'native-model' }));
  await checkDial('geminiGenerateContent', customPipelines.geminiGenerateContent, {
    ...base, upstream: configured, model: geminiModel, geminiGenerateContent: geminiPayload,
  }, '/provider/models/native%2Fmodel:streamGenerateContent?tenant=google&alt=sse&tag=a&tag=b', verifyJson(geminiPayload, 'x-goog-api-key', 'wire-key'));
  await checkDial('geminiGenerateContentCountTokens', customPipelines.geminiGenerateContentCountTokens, {
    ...base, upstream: configured, model: geminiModel, geminiGenerateContentCountTokens: { contents: geminiPayload.contents },
  }, '/provider/models/native%2Fmodel:countTokens?tenant=google&alt=json&tag=a&tag=b', verifyJson({
    generateContentRequest: { ...geminiPayload, model: 'models/native/model' },
  }, 'x-goog-api-key', 'wire-key'));
});

it('serializes a cross-dialect rerank request to the target default path', async () => {
  await checkDial('rerank', customPipelines.rerank, {
    ...base,
    model: { ...model, rerankTarget: { protocol: 'cohere-v2' } },
    rerank: { ...rerank, sourceProtocol: 'cohere-v1', topN: 1 },
  }, '/v2/rerank', verifyJson({ model: 'native-model', query: 'query', documents: ['document'], top_n: 1 }));
});

it('preserves ordered ingress duplicates, tags actual credentials and retains Anthropic-owned beta', async () => {
  const configured: CustomUpstreamConfig = {
    ...config,
    ingressHeadersRules: [
      { key: 'x-tag', value: 'before' },
      { key: 'x-tag', value: null },
      { key: 'x-tag', value: 'after' },
      { key: 'anthropic-version', value: 'operator-version' },
    ],
  };
  const headers: UpstreamRequestFacts['http']['headers'] = [
    ['X-Tag', 'client-1'], ['x-tag', 'client-2'], ['x-unlisted', 'not-admitted'],
    ['anthropic-beta', 'beta-1'], ['Anthropic-Beta', 'beta-2'],
    ['authorization', 'client-credential'], ['x-api-key', 'client-credential'],
  ];
  const incoming = { ...base.http, headers };
  const request: UpstreamRequest<'anthropicMessagesCountTokens'> = {
    ...base,
    upstream: { ...upstream, config: configured },
    http: incoming,
    anthropicMessagesCountTokens: messagesPayload,
  };
  const { execution } = runWith(customPipelines.anthropicMessagesCountTokens, request, async (_url, init) => {
    expect(init.headers).toEqual([
      ['anthropic-beta', 'beta-1'], ['Anthropic-Beta', 'beta-2'],
      ['x-tag', 'before'], ['x-tag', 'client-1'], ['x-tag', 'client-2'], ['x-tag', 'after'],
      ['anthropic-version', 'operator-version'], ['x-api-key', 'wire-key'], ['content-type', 'application/json'],
    ]);
    return Response.json({ input_tokens: 3, vendor: 'retained' });
  });
  await expect(execution.result).resolves.toMatchObject({
    anthropicMessagesCountTokens: { kind: 'result', result: { input_tokens: 3, vendor: 'retained' } },
  });
  for (const [auth, header] of [['bearer', 'authorization'], ['x-api-key', 'x-api-key'], ['x-goog-api-key', 'x-goog-api-key']] as const) {
    const prepared = customHeaders(headers, configured, auth, 'application/json');
    expect(prepared.filter(([name]) => name === 'x-tag').map(([, value]) => value)).toEqual(['before', 'client-1', 'client-2', 'after']);
    const credential = prepared.find(([name]) => name === header)?.[1];
    expect(typeof credential).toBe('object');
    expect(String(credential)).toBe('[secret]');
    expect(JSON.stringify(prepared)).not.toContain('wire-key');
  }
  expect(customHeaders(headers, { ...configured, apiKey: '' }, 'bearer', 'application/json').some(([key]) => key === 'authorization')).toBe(false);
  expect(incoming.headers).toBe(headers);
});

it('keeps upstream headers and JSON errors, renders text errors, and distinguishes dial failures from panics', async () => {
  const request: UpstreamRequest<'openaiEmbeddings'> = { ...base, openaiEmbeddings: { model: 'public-model', input: 'example' } };
  const pipeline = customPipelines.openaiEmbeddings;
  const headerLines = [['x-limit', 'one'], ['x-limit', 'two']] as const;
  const upstreamError = runWith(pipeline, request, async () => Object.assign(new Response('{"error":{"code":9007199254740993}}', {
    status: 429,
    statusText: 'Rate Limited',
  }), { headerLines }));
  const answer = await upstreamError.execution.result;
  expect(answer.http).toEqual({ status: 429, statusText: 'Rate Limited', headers: headerLines, body: null, startedAt: expect.any(Number) });
  if (answer.openaiEmbeddings.kind !== 'error') throw new Error('Expected upstream failure');
  expect(answer.openaiEmbeddings.source).toBe('upstream');
  expect(JSON.stringify(answer.openaiEmbeddings.error)).toBe('{"error":{"code":9007199254740993}}');

  const textError = runWith(pipeline, request, async () => new Response('upstream said no', { status: 403 }));
  await expect(textError.execution.result).resolves.toMatchObject({
    http: { status: 403 },
    openaiEmbeddings: { kind: 'error', source: 'upstream', error: { error: { type: 'invalid_request_error', message: 'upstream said no' } } },
  });
  const outage = runWith(pipeline, request, async () => { throw new HttpTransportError(new Error('dial failed')); });
  await expect(outage.execution.result).resolves.toEqual({
    http: null,
    openaiEmbeddings: {
      kind: 'error', source: 'upstream', error: {
        error: {
          type: 'server_error', message: 'dial failed', provider_specific_fields: {
            name: 'HttpTransportError', stack: expect.any(String),
            cause: { name: 'Error', message: 'dial failed', stack: expect.any(String) },
          },
        },
      },
    },
  });
  const geminiOutage = runWith(customPipelines.geminiGenerateContentCountTokens, {
    ...base, model: geminiModel, geminiGenerateContentCountTokens: geminiCount,
  }, async () => { throw new HttpTransportError(new Error('dial failed', { cause: new Error('peer reset') })); });
  await expect(geminiOutage.execution.result).resolves.toEqual({
    http: null,
    geminiGenerateContentCountTokens: {
      kind: 'error', source: 'upstream', error: {
        error: {
          code: 500, status: 'INTERNAL', message: 'dial failed', details: [
            { '@type': 'type.googleapis.com/google.rpc.DebugInfo', stackEntries: expect.arrayContaining([expect.stringContaining('dial failed')]) },
            {
              '@type': 'type.googleapis.com/google.protobuf.Struct', value: {
                type: 'internal_error', name: 'HttpTransportError', cause: {
                  name: 'Error', message: 'dial failed', stack: expect.any(String),
                  cause: { name: 'Error', message: 'peer reset', stack: expect.any(String) },
                },
              },
            },
          ],
        },
      },
    },
  });
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const cancelled = runWith(pipeline, request, async (_url, { signal }) => {
    started.resolve();
    return await new Promise((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
  }, controller.signal);
  await started.promise;
  controller.abort(new Error('client disconnected'));
  await expect(cancelled.execution.result).resolves.toEqual({
    http: null,
    openaiEmbeddings: { kind: 'error', source: 'local', error: { error: { type: 'invalid_request_error', message: 'Upstream request cancelled' } } },
  });
  const panic = new TypeError('unexpected fetch bug');
  const broken = runWith(pipeline, request, async () => { throw panic; });
  await expect(broken.execution.result).rejects.toBe(panic);
});

const sse = (body: string) => new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });

it('normalizes DeepSeek and Kimi chat usage and reasoning before the stream reaches native done', async () => {
  const assistant: OpenAIChatCompletionsAssistantMessageEx = {
    role: 'assistant',
    content: 'hello',
    reasoning_items: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'previous reasoning' }] }],
  };
  const payload: UpstreamRequestFacts['openaiChatCompletions'] = {
    model: 'public-model',
    messages: [assistant],
    reasoning_effort: 'none',
    response_format: { type: 'json_schema', json_schema: { name: 'answer' } },
  };
  const { execution } = runWith(customPipelines.openaiChatCompletions, {
    ...base,
    model: { ...model, enabledFlags: ['vendor-deepseek', 'vendor-kimi'] },
    openaiChatCompletions: payload,
  }, async (_url, init) => {
    expect(jsonBody(init)).toEqual({
      model: 'native-model',
      messages: [{ role: 'assistant', content: 'hello', reasoning_content: 'previous reasoning' }],
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
      stream: true,
    });
    return sse('data: {"choices":[{"index":0,"delta":{"reasoning_content":"new reasoning"}}],"usage":{"total_tokens":6,"cached_tokens":2,"prompt_cache_hit_tokens":3,"prompt_cache_miss_tokens":1}}\n\ndata: [DONE]\n\n');
  });
  const { openaiChatCompletions } = await execution.result;
  if (openaiChatCompletions.kind !== 'stream') throw new Error('Expected chat stream');
  const stream = execution.read(openaiChatCompletions.stream);
  await expect(stream.next()).resolves.toEqual({
    done: false,
    value: { ok: true, value: { choices: [{ index: 0, delta: { reasoning_text: 'new reasoning' } }], usage: { total_tokens: 6, prompt_tokens_details: { cached_tokens: 3 } } } },
  });
  await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
});

it('applies Qwen Responses conversion and Mistral projection to the dispatched bodies', async () => {
  await checkDial('openaiResponses', customPipelines.openaiResponses, {
    ...base,
    model: { ...model, enabledFlags: ['vendor-qwen'] },
    openaiResponses: { ...responsesPayload, reasoning: { effort: 'none' } },
  }, '/custom-responses', verifyJson({ ...responsesPayload, model: 'native-model', stream: true, enable_thinking: false }));
  const assistant: OpenAIChatCompletionsAssistantMessageEx = {
    role: 'assistant', content: 'hello', refusal: null, reasoning_content: 'private',
  };
  await checkDial('openaiChatCompletions', customPipelines.openaiChatCompletions, {
    ...base,
    model: { ...model, enabledFlags: ['vendor-mistral'] },
    openaiChatCompletions: {
      ...messagesPayload,
      messages: [assistant],
      max_completion_tokens: 14,
      metadata: { user_id: 'gateway-only' },
      stream_options: { include_usage: true, continuous_usage_stats: true },
    },
  }, '/v1/chat/completions', verifyJson({
    model: 'native-model',
    messages: [{ role: 'assistant', content: 'hello' }],
    max_tokens: 14,
    stream: true,
    stream_options: { include_usage: true },
  }));
});

it('returns binary speech and decodes speech and transcription event streams', async () => {
  const audio = new Uint8Array([0x00, 0x7f, 0xff]);
  const binary = runWith(customPipelines.openaiAudioSpeech, { ...base, openaiAudioSpeech: speechPayload }, async () =>
    new Response(audio, { headers: { 'content-type': 'audio/mpeg' } }));
  await expect(binary.execution.result).resolves.toMatchObject({ openaiAudioSpeech: { kind: 'result', result: audio } });

  const speech = runWith(customPipelines.openaiAudioSpeech, {
    ...base, openaiAudioSpeech: { ...speechPayload, stream_format: 'sse' },
  }, async () => sse('data: {"type":"speech.audio.delta","audio":"YQ=="}\n\ndata: [DONE]\n\n'));
  const { openaiAudioSpeech } = await speech.execution.result;
  if (openaiAudioSpeech.kind !== 'stream') throw new Error('Expected speech stream');
  const speechEvents = speech.execution.read(openaiAudioSpeech.stream);
  await expect(speechEvents.next()).resolves.toEqual({ done: false, value: { ok: true, value: { type: 'speech.audio.delta', audio: 'YQ==' } } });
  await expect(speechEvents.next()).resolves.toEqual({ done: true, value: undefined });

  const transcription = runWith(customPipelines.openaiAudioTranscriptions, {
    ...base, openaiAudioTranscriptions: transcriptions,
  }, async () => sse('event: transcript.text.done\ndata: {"type":"transcript.text.done","text":"hello"}\n\n'));
  const { openaiAudioTranscriptions } = await transcription.execution.result;
  if (openaiAudioTranscriptions.kind !== 'stream') throw new Error('Expected transcription stream');
  const transcriptionEvents = transcription.execution.read(openaiAudioTranscriptions.stream);
  await expect(transcriptionEvents.next()).resolves.toMatchObject({ done: false, value: { ok: true, value: { eventName: 'transcript.text.done', data: { text: 'hello' } } } });
  await expect(transcriptionEvents.next()).resolves.toEqual({ done: true, value: undefined });
});

it('cancels the transcription source at the terminal event before delivering native done', async () => {
  const releaseCancel = Promise.withResolvers<void>();
  const encoder = new TextEncoder();
  let upstreamBody!: ReadableStreamDefaultController<Uint8Array>;
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      upstreamBody = controller;
      controller.enqueue(encoder.encode('data: {"type":"transcript.text.delta","delta":"hel"}\n\n'));
      controller.enqueue(encoder.encode('event: transcript.text.done\ndata: {"type":"transcript.text.done","text":"hello"}\n\n'));
    },
    async cancel() {
      cancellations++;
      await releaseCancel.promise;
    },
  });
  const { execution } = runWith(customPipelines.openaiAudioTranscriptions, {
    ...base, openaiAudioTranscriptions: transcriptions,
  }, async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
  const { openaiAudioTranscriptions } = await execution.result;
  if (openaiAudioTranscriptions.kind !== 'stream') throw new Error('Expected transcription stream');
  const events = execution.read(openaiAudioTranscriptions.stream);
  await expect(events.next()).resolves.toMatchObject({ done: false, value: { ok: true, value: { data: { delta: 'hel' } } } });
  await expect(events.next()).resolves.toEqual({
    done: false,
    value: { ok: true, value: { eventName: 'transcript.text.done', data: { type: 'transcript.text.done', text: 'hello' } } },
  });
  let settled = false;
  const ending = events.next().then(item => {
    settled = true;
    return item;
  });
  try {
    await vi.waitFor(() => expect(cancellations).toBe(1), { timeout: 500, interval: 5 });
    expect(settled).toBe(false);
  } finally {
    releaseCancel.resolve();
    if (cancellations === 0) upstreamBody.close();
    await expect(ending).resolves.toEqual({ done: true, value: undefined });
  }
});

it.each(['abort', 'transport', 'panic'] as const)('preserves a transcription %s after partial output', async kind => {
  const controller = new AbortController();
  const stop = new Error('client disconnected');
  const failure = kind === 'transport' ? new HttpTransportError(new Error('upstream read failed')) : new TypeError('upstream body adapter bug');
  let upstreamBody!: ReadableStreamDefaultController<Uint8Array>;
  let abortCause: unknown;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      upstreamBody = value;
      value.enqueue(new TextEncoder().encode('data: {"type":"transcript.text.delta","delta":"hel"}\n\n'));
    },
  });
  const { execution } = runWith(customPipelines.openaiAudioTranscriptions, {
    ...base, openaiAudioTranscriptions: transcriptions,
  }, async (_url, { signal }) => {
    if (kind === 'abort') {
      signal!.addEventListener('abort', () => {
        abortCause = signal!.reason;
        upstreamBody.error(abortCause);
      }, { once: true });
    }
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }, controller.signal);
  const { openaiAudioTranscriptions } = await execution.result;
  if (openaiAudioTranscriptions.kind !== 'stream') throw new Error('Expected transcription stream');
  const events = execution.read(openaiAudioTranscriptions.stream);
  await expect(events.next()).resolves.toMatchObject({ done: false, value: { ok: true, value: { data: { delta: 'hel' } } } });
  if (kind !== 'abort') upstreamBody.error(failure);
  controller.abort(stop);
  if (kind === 'panic') {
    await expect(events.next()).rejects.toBe(failure);
    return;
  }
  const next = await events.next();
  if (next.done || next.value.ok) throw new Error('Expected the original upstream failure');
  expect(next.value.error.kind).toBe(kind);
  expect(next.value.error.cause).toBe(kind === 'abort' ? abortCause : failure);
  await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
});

it('retains the terminal transcription frame when raw source cancellation panics', async () => {
  const panic = new TypeError('transcription cancellation bug');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"transcript.text.done","text":"hello"}\n\n'));
    },
    cancel() {
      throw panic;
    },
  });
  const { execution } = runWith(customPipelines.openaiAudioTranscriptions, {
    ...base, openaiAudioTranscriptions: transcriptions,
  }, async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
  const { openaiAudioTranscriptions } = await execution.result;
  if (openaiAudioTranscriptions.kind !== 'stream') throw new Error('Expected transcription stream');
  const events = execution.read(openaiAudioTranscriptions.stream);
  await expect(events.next()).resolves.toMatchObject({ done: false, value: { ok: true, value: { data: { type: 'transcript.text.done', text: 'hello' } } } });
  await expect(events.next()).rejects.toBe(panic);
});

it('preserves successful rerank response bytes for metering before result validation', async () => {
  const ranking = '{ "results":[{"index":0,"relevance_score":1.0}] }';
  const malformed = '{ "results":[{"index":1,"relevance_score":0.9}],"meta":{"billed_units":{"search_units":2}} }';
  const encoder = new TextEncoder();
  const nativeRanking = runWith(customPipelines.rerank, { ...base, model: rerankModel, rerank }, async () => new Response(ranking));
  await expect(nativeRanking.execution.result).resolves.toMatchObject({ rerank: { kind: 'result', result: encoder.encode(ranking) } });
  const crossDialect = runWith(customPipelines.rerank, {
    ...base, model: rerankModel, rerank: { ...rerank, sourceProtocol: 'jina-v1' },
  }, async () => new Response(malformed, { status: 201 }));
  await expect(crossDialect.execution.result).resolves.toMatchObject({
    http: { status: 201, body: null },
    rerank: { kind: 'result', result: encoder.encode(malformed) },
  });
});

it('preserves native and cross-dialect Decision response bytes for metering before validation', async () => {
  const choice = '{ "answers":[{"name":"wanted","type":"predicate","probability":0.50}] }';
  const malformed = '{ "answers":[{"name":"wanted","type":"predicate"}],"usage":{"input_tokens":37} }';
  const encoder = new TextEncoder();
  const nativeDecision = runWith(customPipelines.decision, { ...base, model: decisionModel, decision }, async () => new Response(choice));
  await expect(nativeDecision.execution.result).resolves.toMatchObject({ decision: { kind: 'result', result: encoder.encode(choice) } });
  const crossDialect = runWith(customPipelines.decision, {
    ...base, model: decisionModel, decision: { ...decision, sourceProtocol: 'typesafe-systemone' },
  }, async () => new Response(malformed, { status: 201 }));
  await expect(crossDialect.execution.result).resolves.toMatchObject({
    http: { status: 201, body: null },
    decision: { kind: 'result', result: encoder.encode(malformed) },
  });
});

it.each([
  { status: 204, outcome: { kind: 'result', result: null } },
  { status: 205, outcome: { kind: 'result', result: null } },
  { status: 200, outcome: { kind: 'error', source: 'upstream' } },
])('classifies empty Anthropic and Gemini count_tokens responses with HTTP $status', async ({ status, outcome }) => {
  const anthropic = runWith(customPipelines.anthropicMessagesCountTokens, {
    ...base, anthropicMessagesCountTokens: messagesPayload,
  }, async () => new Response(null, { status }));
  await expect(anthropic.execution.result).resolves.toMatchObject({
    http: { status, body: null }, anthropicMessagesCountTokens: outcome,
  });

  const gemini = runWith(customPipelines.geminiGenerateContentCountTokens, {
    ...base, model: geminiModel, geminiGenerateContentCountTokens: geminiCount,
  }, async () => new Response(null, { status }));
  await expect(gemini.execution.result).resolves.toMatchObject({
    http: { status, body: null }, geminiGenerateContentCountTokens: outcome,
  });
});

it.each([
  {
    name: 'the alternate total_tokens field',
    body: { total_tokens: 7, vendor: 'retained' },
    outcome: { kind: 'result', result: { input_tokens: 7, total_tokens: 7, vendor: 'retained' } },
  },
  {
    name: 'the native input_tokens field alongside total_tokens',
    body: { input_tokens: 3, total_tokens: 7 },
    outcome: { kind: 'result', result: { input_tokens: 3, total_tokens: 7 } },
  },
  {
    name: 'a fractional alternate count',
    body: { total_tokens: 1.5 },
    outcome: { kind: 'error', source: 'upstream' },
  },
  {
    name: 'an invalid native count alongside total_tokens',
    body: { input_tokens: null, total_tokens: 7 },
    outcome: { kind: 'error', source: 'upstream' },
  },
])('decodes Custom Anthropic count with $name', async ({ body, outcome }) => {
  const { execution } = runWith(customPipelines.anthropicMessagesCountTokens, {
    ...base, anthropicMessagesCountTokens: messagesPayload,
  }, async () => Response.json(body));
  await expect(execution.result).resolves.toMatchObject({
    http: { status: 200, body: null },
    anthropicMessagesCountTokens: outcome,
  });
});

it.each([200, 429])('caps a buffered count response with upstream status %s', async status => {
  const { execution, background } = runWith(customPipelines.anthropicMessagesCountTokens, {
    ...base, anthropicMessagesCountTokens: messagesPayload,
  }, async () => new Response(new Uint8Array(1024 * 1024 + 1), { status }));
  await expect(execution.result).rejects.toThrow('Upstream response body exceeds 1048576 bytes');
  await Promise.all(background);
});
