import { expect, test, vi } from 'vitest';

import { copilotPipelines } from '../../src/pipelines/index.ts';
import type { CopilotService, CopilotServices } from '../../src/service.ts';
import { getHeader, type FetchInit, type HttpHeaders } from '@floway-dev/http';
import { move, run, Secret } from '@floway-dev/pipeline';
import { PROMPT_TOO_LONG_MESSAGE } from '@floway-dev/protocols/anthropic-messages';
import { parseDecisionRequest } from '@floway-dev/protocols/decision';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import type { ProviderModelFact } from '@floway-dev/provider';
import { assert, stubProviderModel } from '@floway-dev/test-utils';

const requestFacts = (headers: HttpHeaders = [], model?: ProviderModelFact) => ({
  'request.http': move({ url: 'https://floway.test', method: 'POST', headers, body: null }),
  'provider.upstream': move({ id: 'copilot-1', kind: 'copilot' as const, name: 'Copilot', config: {} }),
  'provider.model': move(model ?? { ...stubProviderModel({}), enabledFlags: [] }),
});

const servicesFor = (response: () => Response, overrides: Partial<CopilotService> = {}) => {
  const fetcher = vi.fn((_url: string, _init: FetchInit) => Promise.resolve({ ok: true, value: response() } as const));
  const observeQuota = vi.fn(() => Promise.resolve());
  const selectModel = vi.fn<CopilotService['selectModel']>(async () => ({ kind: 'model', id: 'raw-model' }));
  const services = {
    fetcher: () => fetcher,
    copilot: {
      async credentials() {
        return { ok: true, value: { baseUrl: 'https://copilot.test', token: Secret.from('access-token') } };
      },
      identityHeaders: () => [
        ['user-agent', 'GitHubCopilotChat'],
        ['copilot-integration-id', 'vscode-chat'],
        ['openai-intent', 'conversation-agent'],
      ],
      compressImage: bytes => Promise.resolve(bytes),
      selectModel,
      observeQuota,
      refreshCatalog: () => Promise.reject(new Error('unexpected catalog refresh')),
      clearTokens: () => {},
      ...overrides,
    },
  } satisfies CopilotServices;
  return { services, fetcher, observeQuota, selectModel };
};

const wireJson = (init: FetchInit): Record<string, unknown> => {
  if (typeof init.body !== 'string') throw new TypeError('Expected JSON request');
  return JSON.parse(init.body) as Record<string, unknown>;
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
  const { services, fetcher } = servicesFor(() => upstream);
  const facts = requestFacts();
  const model = facts['provider.model'];
  const exchange = run(copilotPipelines.openaiChatCompletions, {
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
  const { services } = servicesFor(() => upstream);
  const exchange = run(copilotPipelines.anthropicMessagesCountTokens, {
    ...requestFacts(),
    'request.anthropicMessages': move({ model: 'public', messages: [] }),
  }, { services });
  const answer = await exchange.result;
  await exchange.done;
  expect(answer['response.http']).toMatchObject({ status: 204, headers: [['x-upstream', 'empty-count']], body: null });
  expect(answer['response.anthropicMessages']).toEqual({ kind: 'result', result: null });
});

test('Copilot embeddings preserve the wire model and mark credentials across the HTTP handoff', async () => {
  const { services, fetcher, observeQuota } = servicesFor(() =>
    Response.json({ object: 'list', data: [] }, { headers: { 'x-quota-snapshot-chat': 'ent=100' } }));
  const started = run(copilotPipelines.openaiEmbeddings, {
    ...requestFacts([['authorization', 'client-secret'], ['x-client-header', 'client']]),
    'request.openaiEmbeddings': move({ model: 'visible-model', input: 'text' }),
  }, {
    services,
    events(event) {
      if (event.type !== 'stage.entered' || event.name !== 'http') return;
      const request = event.facts['request.http'] as { headers: HttpHeaders };
      expect(getHeader(request.headers, 'authorization')).toBeInstanceOf(Secret);
      expect(JSON.stringify(request)).not.toContain('access-token');
    },
  });
  const result = await started.result;
  await started.done;

  const [url, init] = fetcher.mock.calls[0];
  const headers = new Headers(init.headers);
  expect(url).toBe('https://copilot.test/embeddings');
  expect(headers.get('authorization')).toBe('Bearer access-token');
  expect(headers.get('x-client-header')).toBeNull();
  expect(wireJson(init)).toEqual({ model: 'raw-model', input: ['text'] });
  expect(result['response.modelKey']).toBe('raw-model');
  expect(result['response.openaiEmbeddings']).toEqual({ kind: 'result', result: { object: 'list', data: [] } });
  expect(observeQuota).toHaveBeenCalledWith('copilot-1', expect.arrayContaining([['x-quota-snapshot-chat', 'ent=100']]));
});

test.each(['openaiResponses', 'openaiResponsesCompact'] as const)('GitHub token failure preserves the HTTP response and model key for %s', async operation => {
  const { services, fetcher } = servicesFor(() => Response.json({}), {
    credentials: async () => ({
      ok: false,
      error: {
        kind: 'response',
        http: { status: 403, statusText: '', headers: [['x-github-request-id', 'token-request-id']] },
        body: 'access denied',
      },
    }),
  });
  const facts = {
    ...requestFacts(),
    'request.openaiResponses': move({ model: 'visible-model', input: [] }),
  };
  const started = operation === 'openaiResponses'
    ? run(copilotPipelines.openaiResponses, facts, { services })
    : run(copilotPipelines.openaiResponsesCompact, facts, { services });
  const result = await started.result;
  await started.done;

  expect(fetcher).not.toHaveBeenCalled();
  expect(result['response.modelKey']).toBe('raw-model');
  expect(result['response.http']).toMatchObject({ status: 403, headers: expect.arrayContaining([['x-github-request-id', 'token-request-id']]) });
  const outcome = result['response.openaiResponses'];
  expect(outcome).toMatchObject({
    kind: 'error',
    source: 'upstream',
    error: { type: 'error', message: 'access denied' },
  });
  expect(outcome.kind === 'error' && outcome.cause).toBeInstanceOf(SyntaxError);
});

test('Copilot generates Anthropic Messages with selected Fast Mode and reports it in the opening event', async () => {
  const events = [
    { type: 'message_start', message: { id: 'm', usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'message_delta', usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ];
  const { services, fetcher, selectModel } = servicesFor(() => new Response(
    events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  ));
  const started = run(copilotPipelines.anthropicMessages, {
    ...requestFacts([['anthropic-beta', 'context-1m-2025-08-07, advanced-tool-use-2025-11-20']]),
    'request.anthropicMessages': move({ model: 'visible-model', max_tokens: 16, messages: [], speed: 'fast', stream: false }),
  }, { services });
  const outcome = (await started.result)['response.anthropicMessages'];
  if (outcome.kind !== 'stream') throw new Error('Expected Anthropic Messages stream');
  const items = await Array.fromAsync(outcome.stream);
  await started.done;

  const init = fetcher.mock.calls[0][1];
  expect(wireJson(init)).toMatchObject({ model: 'raw-model', stream: true });
  expect(wireJson(init)).not.toHaveProperty('speed');
  expect(selectModel).toHaveBeenCalledWith('copilot-1', expect.any(String), 'anthropicMessages', expect.objectContaining({ fast: true, context1m: true }));
  expect(new Headers(init.headers).get('anthropic-beta')).toBe('advanced-tool-use-2025-11-20');
  expect(items[0]).toMatchObject({ ok: true, value: { message: { usage: { speed: 'fast' } } } });
  expect(items[1]).toMatchObject({ ok: true, value: { type: 'message_delta', usage: { output_tokens: 4 } } });
  expect(items[1]).not.toHaveProperty('value.usage.speed');
});

test('Copilot preserves upstream JSON errors and repeated response headers', async () => {
  const error = { error: { code: 'bad_image', message: 'invalid image' } };
  const { services } = servicesFor(() => Response.json(error, {
    status: 422,
    headers: [['set-cookie', 'a=1'], ['set-cookie', 'b=2']],
  }));
  const started = run(copilotPipelines.openaiImagesGenerations, {
    ...requestFacts(),
    'request.openaiImagesGenerations': move({ model: 'visible-model', prompt: 'draw something' }),
  }, { services });
  const result = await started.result;
  await started.done;
  expect(result['response.http']).toMatchObject({
    status: 422,
    headers: expect.arrayContaining([['set-cookie', 'a=1'], ['set-cookie', 'b=2']]),
  });
  expect(result['response.openaiImagesGenerations']).toEqual({ kind: 'error', source: 'upstream', error });
});

test('Copilot Chat Completions aborts and drains an open upstream stream on degenerate tool arguments', async () => {
  const chunk = {
    id: 'chunk-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'raw-model',
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '\n'.repeat(21) } }] }, finish_reason: null }],
  };
  const cancel = vi.fn();
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`);
  const { services, fetcher } = servicesFor(() => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes); },
    cancel,
  }), { headers: { 'content-type': 'text/event-stream' } }));

  const started = run(copilotPipelines.openaiChatCompletions, {
    ...requestFacts(),
    'request.openaiChatCompletions': move({ model: 'visible-model', messages: [{ role: 'user' as const, content: 'hello' }] }),
  }, { services });
  const result = await started.result;
  const outcome = result['response.openaiChatCompletions'];
  if (outcome.kind !== 'stream') throw new Error('Expected Chat Completions stream');
  const items = await Array.fromAsync(outcome.stream);
  await started.done;

  expect(cancel).toHaveBeenCalledOnce();
  expect(items).toEqual([{ ok: false, error: { kind: 'protocol', cause: expect.any(Error) } }]);
  expect(result['response.http']?.body).toBeNull();
  expect(wireJson(fetcher.mock.calls[0][1])).toMatchObject({
    model: 'raw-model',
    stream: true,
    messages: [{ role: 'user', content: 'hello', copilot_cache_control: { type: 'ephemeral' } }],
  });
});

test('Copilot Responses ends with its synthesized error and drains the upstream abort failure', async () => {
  const delta = { type: 'response.function_call_arguments.delta', output_index: 0, delta: '\n'.repeat(21) };
  const cancel = vi.fn();
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify(delta)}\n\n`);
  const { services } = servicesFor(() => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes); },
    cancel,
  }), { headers: { 'content-type': 'text/event-stream' } }));
  const failures: unknown[] = [];
  const started = run(copilotPipelines.openaiResponses, {
    ...requestFacts(),
    'request.openaiResponses': move({ model: 'visible-model', input: [] }),
  }, {
    services,
    events(event) {
      if (event.type === 'stream.frame' && !event.item.ok) failures.push(event.item.error);
    },
  });
  const outcome = (await started.result)['response.openaiResponses'];
  if (outcome.kind !== 'stream') throw new Error('Expected OpenAI Responses stream');
  const items = await Array.fromAsync(outcome.stream);
  await started.done;

  expect(cancel).toHaveBeenCalledOnce();
  expect(failures).toContainEqual(expect.objectContaining({ kind: 'abort' }));
  expect(items).toEqual([{ ok: true, value: expect.objectContaining({ type: 'error', code: 'api_error' }) }]);
});

test('Copilot rejects unavailable Anthropic fast mode before dispatch', async () => {
  const { services, fetcher } = servicesFor(() => Response.json({}), {
    selectModel: async () => ({ kind: 'unsupportedFast' }),
  });
  const started = run(copilotPipelines.anthropicMessages, {
    ...requestFacts(),
    'request.anthropicMessages': move({ model: 'visible-model', max_tokens: 16, messages: [], speed: 'fast' }),
  }, { services });
  const result = await started.result;
  await started.done;
  expect(fetcher).not.toHaveBeenCalled();
  expect(result['response.http']?.status).toBe(400);
  expect(result['response.anthropicMessages']).toMatchObject({
    kind: 'error', source: 'local', error: { type: 'error', error: { type: 'invalid_request_error' } },
  });
});

test('Copilot carries Anthropic beta intent through variant selection, then normalizes the count-tokens request', async () => {
  const { services, fetcher, selectModel } = servicesFor(() => Response.json({ input_tokens: 48 }));
  const started = run(copilotPipelines.anthropicMessagesCountTokens, {
    ...requestFacts([['Anthropic-Beta', 'context-1m-2025-08-07'], ['anthropic-beta', 'advanced-tool-use-2025-11-20']]),
    'request.anthropicMessages': move({ model: 'visible-model', messages: [{ role: 'user' as const, content: 'hello' }] }),
  }, { services });
  const result = await started.result;
  await started.done;

  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe('https://copilot.test/v1/messages/count_tokens');
  expect(selectModel).toHaveBeenCalledWith('copilot-1', expect.any(String), 'anthropicMessages', expect.objectContaining({ context1m: true, fast: false }));
  expect(new Headers(init.headers).get('anthropic-beta')).toBe('advanced-tool-use-2025-11-20');
  expect(wireJson(init)).toEqual({ model: 'raw-model', messages: [{ role: 'user', content: 'hello' }] });
  expect(result['response.anthropicMessages']).toEqual({ kind: 'result', result: { input_tokens: 48 } });
});

test('Copilot Anthropic context errors retain upstream HTTP and expose the canonical compaction signal', async () => {
  const { services } = servicesFor(() => new Response('Request body is too large for model context window', {
    status: 413,
    headers: { 'x-request-id': 'context-error' },
  }));
  const started = run(copilotPipelines.anthropicMessages, {
    ...requestFacts(),
    'request.anthropicMessages': move({ model: 'visible-model', max_tokens: 16, messages: [] }),
  }, { services });
  const result = await started.result;
  await started.done;
  expect(result['response.http']?.status).toBe(413);
  expect(result['response.http']?.headers).toContainEqual(['x-request-id', 'context-error']);
  expect(result['response.anthropicMessages']).toMatchObject({
    kind: 'error', source: 'upstream', error: { error: { message: PROMPT_TOO_LONG_MESSAGE } },
  });
});

test('Copilot Responses compresses repeated image content before serializing native tool outputs', async () => {
  const compressImage = vi.fn(async () => new Uint8Array([4, 5, 6]));
  const { services, fetcher } = servicesFor(() => new Response('data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  }), { compressImage });
  const image = () => ({ type: 'input_image' as const, image_url: 'data:image/png;base64,AAEC' });
  const started = run(copilotPipelines.openaiResponses, {
    ...requestFacts(),
    'request.openaiResponses': move({
      model: 'visible-model',
      input: [
        { type: 'message' as const, role: 'user' as const, content: [image()] },
        { type: 'function_call_output' as const, call_id: 'call-1', output: [image()] },
      ],
    }),
  }, { services });
  const result = await started.result;
  const outcome = result['response.openaiResponses'];
  if (outcome.kind !== 'stream') throw new Error('Expected OpenAI Responses stream');
  await Array.fromAsync(outcome.stream);
  await started.done;

  const init = fetcher.mock.calls[0][1];
  expect(new Headers(init.headers).get('copilot-vision-request')).toBe('true');
  expect(new Headers(init.headers).get('x-initiator')).toBe('agent');
  expect(compressImage).toHaveBeenCalledOnce();
  expect(wireJson(init)).toMatchObject({
    stream: true,
    input: [
      { type: 'message', content: [{ type: 'input_image', image_url: 'data:image/webp;base64,BAUG' }] },
      { type: 'function_call_output', output: [{ type: 'input_image', image_url: 'data:image/webp;base64,BAUG' }] },
    ],
  });
});

test('Copilot compact sends one trigger turn and returns normalized compaction state', async () => {
  const { services, fetcher, selectModel } = servicesFor(() => Response.json({
    id: 'response-id',
    object: 'response',
    output: [{ type: 'compaction', id: 'upstream-compaction', encrypted_content: 'encrypted' }],
  }));
  const started = run(copilotPipelines.openaiResponsesCompact, {
    ...requestFacts(),
    'request.openaiResponses': move({
      model: 'visible-model',
      input: [{
        type: 'message' as const,
        role: 'user' as const,
        content: [{ type: 'input_image' as const, image_url: 'https://example.test/retain.png' }],
      }],
      service_tier: 'priority',
      store: true,
    }),
  }, { services });
  const result = await started.result;
  await started.done;
  const init = fetcher.mock.calls[0][1];
  const body = wireJson(init);
  expect(new Headers(init.headers).get('copilot-vision-request')).toBe('true');
  expect(new Headers(init.headers).get('x-initiator')).toBe('user');
  expect(selectModel).toHaveBeenCalledWith('copilot-1', expect.any(String), 'openaiResponses', expect.objectContaining({ fast: true }));
  expect(body).toMatchObject({
    model: 'raw-model',
    stream: false,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'https://example.test/retain.png' }] }, { type: 'compaction_trigger' }],
  });
  expect(body).not.toHaveProperty('service_tier');
  expect(body).not.toHaveProperty('store');
  expect(result['response.openaiResponses']).toMatchObject({
    kind: 'result',
    result: { object: 'response.compaction', output: [{ type: 'message' }, { type: 'compaction', id: expect.stringMatching(/^cmp_/) }] },
  });
});

test('Copilot image edits send multipart bytes with the matching boundary', async () => {
  const { services, fetcher } = servicesFor(() => Response.json({ data: [] }));
  const started = run(copilotPipelines.openaiImagesEdits, {
    ...requestFacts(),
    'request.openaiImagesEdits': move({
      images: [{ type: 'upload' as const, file: { name: 'test.png', type: 'image/png', bytes: new Uint8Array([0, 1, 2]) } }],
      parameters: { prompt: 'edit this' },
    }),
  }, { services });
  const result = await started.result;
  await started.done;
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe('https://copilot.test/v1/images/edits');
  expect(init.body).toBeInstanceOf(Uint8Array);
  const contentType = new Headers(init.headers).get('content-type');
  expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
  const form = await new Response(init.body as Uint8Array<ArrayBuffer>, { headers: { 'content-type': contentType! } }).formData();
  expect(form.get('model')).toBe('raw-model');
  expect(form.get('image')).toBeInstanceOf(File);
  expect(result['response.openaiImagesEdits']).toEqual({ kind: 'result', result: { data: [] } });
});

test.each([
  {
    protocol: 'openai-decisions' as const,
    path: '/v1/decisions',
    request: { questions: [{ name: 'green', type: 'predicate' }] },
    answers: [{ name: 'green', type: 'predicate', probability: 0.75 }],
  },
  {
    protocol: 'typesafe-systemone' as const,
    path: '/v1/systemone',
    request: { state: 'Is the test green?', questions: { green: { type: 'noul', criteria: { true: 'green', false: 'red' } } } },
    answers: { green: { type: 'noul', noul: 0.75 } },
  },
])('Copilot Decision uses $protocol on both sides of the HTTP exchange', async ({ protocol, path, request: wire, answers }) => {
  const parsed = parseDecisionRequest('typesafe-systemone', {
    model: 'visible-model',
    state: 'Is the test green?',
    questions: { green: { type: 'noul', criteria: { true: 'green', false: 'red' } } },
  });
  assert(parsed.ok);
  const { request } = parsed.value;
  const { services, fetcher } = servicesFor(() => Response.json({
    model: 'raw-model',
    answers,
  }));
  const model = { ...stubProviderModel({}), enabledFlags: [], decisionTarget: { protocol } };
  const started = run(copilotPipelines.decision, { ...requestFacts([], model), 'request.decision': move(request) }, { services });
  const result = await started.result;
  await started.done;
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe(`https://copilot.test${path}`);
  expect(wireJson(init)).toMatchObject({ ...wire, model: 'raw-model' });
  expect(result['response.decision']).toMatchObject({ kind: 'result', result: { answers: [{ name: 'green', type: 'noul', noul: 0.75 }] } });
});
