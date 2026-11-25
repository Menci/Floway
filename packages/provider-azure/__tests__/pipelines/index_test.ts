import { assert, expect, test, vi } from 'vitest';

import type { AzureUpstreamConfig } from '../../src/config.ts';
import { azurePipelines } from '../../src/pipelines/index.ts';
import { azureUpstreamFact } from '../../src/upstream.ts';
import type { HttpRequestFact } from '@floway-dev/http';
import { move, run, Secret, type Pipeline } from '@floway-dev/pipeline';
import type { CanonicalDecisionRequest } from '@floway-dev/protocols/decision';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { toProviderModelFact, type OpenAIAudioTranscriptionRequest, type OpenAIImagesEditsRequest, type ProtocolOutcome, type ProviderServices } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

const config: AzureUpstreamConfig = {
  endpoint: 'https://azure.services.ai.azure.com/api/projects/floway',
  apiKey: 'azure-key',
  models: [{ upstreamModelId: 'deployment/model', kind: 'chat', endpoints: { openaiResponses: {} } }],
};
const upstream = azureUpstreamFact({
  id: 'azure-upstream',
  name: 'Azure upstream',
  kind: 'azure',
  config,
  state: null,
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
});
const facts = {
  'request.http': move<HttpRequestFact>({
    method: 'POST',
    url: 'https://floway.example.test/v1/client',
    headers: [
      ['authorization', 'Bearer caller-key'],
      ['x-client', 'removed'],
      ['content-type', 'application/old'],
      ['anthropic-beta', 'own-beta'],
    ],
    body: null,
  }),
  'provider.upstream': move(upstream),
  'provider.model': move(toProviderModelFact(stubProviderModel({ upstreamModelId: 'deployment/model' }))),
};

const transport = (value: Response) => {
  const fetch = vi.fn<ReturnType<ProviderServices['fetcher']>>().mockResolvedValue({ ok: true, value });
  return { fetch, services: { fetcher: () => fetch } };
};

test.each([true, false])('applies DeepSeek Chat Completions normalization when enabled is %s', async enabled => {
  const prompt = {
    role: 'assistant' as const,
    content: 'replay',
    reasoning_opaque: 'opaque-replay',
    reasoning_items: [{ type: 'reasoning' as const, summary: [{ type: 'summary_text' as const, text: 'past thought' }] }],
  };
  const chunk = {
    id: 'vendor-turn',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'raw-model',
    choices: [{ index: 0, delta: { reasoning_content: 'next thought', content: 'next' }, finish_reason: null }],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6 },
  };
  const upstream = new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  const { services, fetch: fetcher } = transport(upstream);
  const model = facts['provider.model'];
  const exchange = run(azurePipelines.openaiChatCompletions, {
    ...facts,
    'provider.model': move({ ...model, enabledFlags: enabled ? ['vendor-deepseek' as const] : [] }),
    'request.openaiChatCompletions': move<OpenAIChatCompletionsPayloadEx>({
      model: 'public',
      messages: [prompt],
      reasoning_effort: 'none',
      response_format: { type: 'json_schema', json_schema: { name: 'result', schema: { type: 'object' } } },
    }),
  }, { services });
  const result = (await exchange.result)['response.openaiChatCompletions'];
  if (result.kind !== 'stream') throw new Error('Expected Chat Completions stream');
  const items = await Array.fromAsync(result.stream);
  await exchange.done;

  const wire = JSON.parse(String(fetcher.mock.calls[0][1].body)) as Record<string, unknown>;
  if (enabled) {
    expect(wire).toMatchObject({
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
      messages: [{ role: 'assistant', content: 'replay', reasoning_content: 'past thought' }],
    });
    expect(wire).not.toHaveProperty('reasoning_effort');
    expect(wire).not.toHaveProperty('messages.0.reasoning_opaque');
    expect(wire).not.toHaveProperty('messages.0.reasoning_items');
    expect(items).toMatchObject([{
      ok: true,
      value: {
        choices: [{ delta: { reasoning_text: 'next thought', content: 'next' } }],
        usage: { prompt_tokens_details: { cached_tokens: 4 } },
      },
    }]);
    expect(items[0]).not.toHaveProperty('value.choices.0.delta.reasoning_content');
    expect(items[0]).not.toHaveProperty('value.usage.prompt_cache_hit_tokens');
    expect(items[0]).not.toHaveProperty('value.usage.prompt_cache_miss_tokens');
  } else {
    expect(wire).toMatchObject({
      reasoning_effort: 'none',
      response_format: { type: 'json_schema' },
      messages: [prompt],
    });
    expect(wire).not.toHaveProperty('thinking');
    expect(items).toMatchObject([{ ok: true, value: chunk }]);
    expect(items[0]).not.toHaveProperty('value.choices.0.delta.reasoning_text');
    expect(items[0]).not.toHaveProperty('value.usage.prompt_tokens_details');
  }
});

test('keeps a bodyless Anthropic count-tokens success', async () => {
  const upstream = new Response(null, { status: 204, headers: { 'x-upstream': 'empty-count' } });
  const { services } = transport(upstream);
  const exchange = run(azurePipelines.anthropicMessagesCountTokens, {
    ...facts,
    'request.anthropicMessages': move({ model: 'public', messages: [] }),
  }, { services });
  const answer = await exchange.result;
  await exchange.done;
  expect(answer['response.http']).toMatchObject({ status: 204, headers: [['x-upstream', 'empty-count']], body: null });
  expect(answer['response.anthropicMessages']).toEqual({ kind: 'result', result: null });
});

test('Responses rewrites empty namespace descriptions and strips ingress headers', async () => {
  expect(upstream.config.apiKey).toBeInstanceOf(Secret);
  expect(JSON.stringify(upstream)).not.toContain('azure-key');
  const { fetch, services } = transport(new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  const exchange = run(azurePipelines.openaiResponses, {
    ...facts,
    'request.openaiResponses': move<CanonicalOpenAIResponsesPayload>({
      model: 'public-model',
      input: [],
      tools: [
        { type: 'namespace', name: 'first', description: '', tools: [] },
        { type: 'namespace', name: 'second', description: 'Existing', tools: [] },
      ],
    }),
  }, { services });
  const answer = await exchange.result;
  const outcome = answer['response.openaiResponses'];
  assert(outcome.kind === 'stream');
  expect(await Array.fromAsync(outcome.stream)).toEqual([]);
  await exchange.done;

  const [[url, options]] = fetch.mock.calls;
  expect(url).toBe('https://azure.services.ai.azure.com/api/projects/floway/openai/v1/responses');
  expect(options.headers).toEqual([['content-type', 'application/json'], ['api-key', 'azure-key']]);
  expect(JSON.parse(String(options.body))).toEqual({
    model: 'deployment/model',
    stream: true,
    input: [],
    tools: [
      { type: 'namespace', name: 'first', description: 'Tools in the first namespace.', tools: [] },
      { type: 'namespace', name: 'second', description: 'Existing', tools: [] },
    ],
  });
  expect(answer['response.http']?.body).toBeNull();
  expect(answer['response.modelKey']).toBe('deployment/model');
});

test('Anthropic count-tokens uses the resource URL and preserves JSON upstream errors', async () => {
  const error = { type: 'error', error: { type: 'rate_limit_error', message: 'Please retry', vendor_field: [1, 2] } };
  const { fetch, services } = transport(Response.json(error, { status: 429, headers: { 'retry-after': '8' } }));
  const exchange = run(azurePipelines.anthropicMessagesCountTokens, {
    ...facts,
    'request.anthropicMessages': move({ model: 'public-model', messages: [] }),
  }, { services });
  const answer = await exchange.result;
  await exchange.done;

  const [[url, options]] = fetch.mock.calls;
  expect(url).toBe('https://azure.services.ai.azure.com/anthropic/v1/messages/count_tokens');
  expect(options.headers).toEqual([
    ['anthropic-beta', 'own-beta'],
    ['content-type', 'application/json'],
    ['x-api-key', 'azure-key'],
    ['anthropic-version', '2023-06-01'],
  ]);
  expect(answer).toMatchObject({
    'response.http': { status: 429, body: null, headers: expect.arrayContaining([['retry-after', '8']]) },
    'response.anthropicMessages': { kind: 'error', source: 'upstream', error },
  });
});

test('audio transcriptions selects the deployment path and sends matching multipart bytes', async () => {
  const bytes = Uint8Array.of(0xff, 0x11, 0x22);
  const { fetch, services } = transport(new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }));
  const exchange = run(azurePipelines.openaiAudioTranscriptions, {
    ...facts,
    'request.openaiAudioTranscriptions': move<OpenAIAudioTranscriptionRequest>({
      entries: [
        { name: 'model', value: 'public-model' },
        { name: 'file', value: { name: 'input.wav', type: 'audio/wav', bytes: Uint8Array.of(1, 2) } },
        { name: 'response_format', value: 'text' },
      ],
    }),
  }, { services });
  const answer = await exchange.result;
  await exchange.done;
  expect(answer['response.openaiAudioTranscriptions']).toEqual({ kind: 'result', result: bytes });

  const [[url, options]] = fetch.mock.calls;
  expect(url).toBe('https://azure.services.ai.azure.com/openai/deployments/deployment%2Fmodel/audio/transcriptions?api-version=2025-04-01-preview');
  const form = await new Response(options.body as Uint8Array<ArrayBuffer>, { headers: new Headers(options.headers) }).formData();
  expect(form.get('model')).toBeNull();
  expect(form.get('response_format')).toBe('text');
  const file = form.get('file');
  assert(file instanceof File);
  expect(file.name).toBe('input.wav');
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(Uint8Array.of(1, 2));
});

const sse = (data: string): Response => new Response(`data: ${data}\n\n`, { headers: { 'content-type': 'text/event-stream' } });

const verifyOperation = <Input, Key extends string, Output extends Record<Key, ProtocolOutcome<unknown, unknown>>>(
  pipeline: Pipeline<Input, Output, ProviderServices>,
  input: NoInfer<Input>,
  key: Key,
  success: () => Response,
  expectedKind: 'result' | 'stream',
): void => {
  test.each(['success', 'upstream error'] as const)(`${pipeline.name} handles %s`, async variant => {
    const error = { error: { message: 'Temporary upstream failure', detail: 'Keep extension fields' } };
    const value = variant === 'success' ? success() : Response.json(error, { status: 503 });
    const { fetch, services } = transport(value);
    const exchange = run(pipeline, input, { services });
    const answer = await exchange.result;
    const outcome = answer[key];
    if (outcome.kind === 'stream') {
      const items = await Array.fromAsync(outcome.stream);
      expect(items.every(item => item.ok)).toBe(true);
    }
    await exchange.done;
    expect(fetch).toHaveBeenCalledOnce();
    expect(answer).toMatchObject({ 'response.http': { status: variant === 'success' ? 200 : 503, body: null } });
    if (variant === 'success') expect(outcome.kind).toBe(expectedKind);
    else expect(outcome).toEqual({ kind: 'error', source: 'upstream', error });
  });
};

verifyOperation(azurePipelines.anthropicMessages, {
  ...facts,
  'request.anthropicMessages': move({ model: 'public', messages: [], max_tokens: 8 }),
}, 'response.anthropicMessages', () => sse('{"type":"message_stop"}'), 'stream');

verifyOperation(azurePipelines.anthropicMessagesCountTokens, {
  ...facts,
  'request.anthropicMessages': move({ model: 'public', messages: [] }),
}, 'response.anthropicMessages', () => Response.json({ input_tokens: 8 }), 'result');

verifyOperation(azurePipelines.decision, {
  ...facts,
  'provider.model': move(toProviderModelFact(stubProviderModel({ decisionTarget: { protocol: 'typesafe-systemone' } }))),
  'request.decision': move<CanonicalDecisionRequest>({ sourceProtocol: 'typesafe-systemone', raw: { state: 'evidence', questions: {} }, state: { kind: 'text', value: 'evidence' }, questions: [] }),
}, 'response.decision', () => new Response('{"answers":{"choice":{"type":"noul","noul":0.5000}}}', { headers: { 'content-type': 'application/json' } }), 'result');

verifyOperation(azurePipelines.openaiAudioTranscriptions, {
  ...facts,
  'request.openaiAudioTranscriptions': move({ entries: [{ name: 'model', value: 'public' }] }),
}, 'response.openaiAudioTranscriptions', () => sse('{"type":"transcript.text.done","text":"speech"}'), 'stream');

verifyOperation(azurePipelines.openaiChatCompletions, {
  ...facts,
  'request.openaiChatCompletions': move({ model: 'public', messages: [] }),
}, 'response.openaiChatCompletions', () => sse('{"id":"unit","object":"chat.completion.chunk","created":1,"model":"unit","choices":[]}'), 'stream');

verifyOperation(azurePipelines.openaiCompletions, {
  ...facts,
  'request.openaiCompletions': move({ model: 'public', prompt: 'hello' }),
}, 'response.openaiCompletions', () => Response.json({ id: 'done', object: 'text_completion', created: 1, model: 'unit', choices: [] }), 'result');

verifyOperation(azurePipelines.openaiEmbeddings, {
  ...facts,
  'request.openaiEmbeddings': move({ model: 'public', input: 'text' }),
}, 'response.openaiEmbeddings', () => Response.json({ data: [] }), 'result');

verifyOperation(azurePipelines.openaiImagesEdits, {
  ...facts,
  'request.openaiImagesEdits': move<OpenAIImagesEditsRequest>({ images: [{ type: 'reference', reference: { file_id: 'file-image' } }], parameters: { prompt: 'Make monochrome' } }),
}, 'response.openaiImagesEdits', () => Response.json({ data: [] }), 'result');

verifyOperation(azurePipelines.openaiImagesGenerations, {
  ...facts,
  'request.openaiImagesGenerations': move({ model: 'public', prompt: 'Draw a circle' }),
}, 'response.openaiImagesGenerations', () => Response.json({ data: [] }), 'result');

verifyOperation(azurePipelines.openaiResponses, {
  ...facts,
  'request.openaiResponses': move({ model: 'public', input: [] }),
}, 'response.openaiResponses', () => sse('[DONE]'), 'stream');

verifyOperation(azurePipelines.openaiResponsesCompact, {
  ...facts,
  'request.openaiResponses': move({ model: 'public', input: [], prompt_cache_options: null }),
}, 'response.openaiResponses', () => Response.json({ id: 'compact', object: 'response.compaction', output: [] }), 'result');
