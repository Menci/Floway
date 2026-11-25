import { expect, test, vi } from 'vitest';

import { CopilotTokenFetchError } from '../../src/auth.ts';
import { copilotPipelines } from '../../src/pipelines/index.ts';
import type { CopilotService, CopilotServices } from '../../src/service.ts';
import { getHeader, type FetchInit, type HttpHeaders } from '@floway-dev/http';
import { move, run, Secret } from '@floway-dev/pipeline';
import { PROMPT_TOO_LONG_MESSAGE } from '@floway-dev/protocols/anthropic-messages';
import { parseDecisionRequest } from '@floway-dev/protocols/decision';
import type { ProviderModelFact } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

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

test('GitHub token exchange failures use the operation error envelope without calling the Copilot API', async () => {
  const tokenFailure = new CopilotTokenFetchError(new Response('access denied', {
    status: 403,
    headers: [['x-github-request-id', 'token-request-id']],
  }), 'access denied');
  const { services, fetcher } = servicesFor(() => Response.json({}), {
    credentials: async () => ({ ok: false, error: tokenFailure }),
  });
  const started = run(copilotPipelines.openaiResponses, {
    ...requestFacts(),
    'request.openaiResponses': move({ model: 'visible-model', input: [] }),
  }, { services });
  const result = await started.result;
  await started.done;

  expect(fetcher).not.toHaveBeenCalled();
  expect(result['response.modelKey']).toBe('raw-model');
  expect(result['response.http']).toMatchObject({ status: 403, headers: expect.arrayContaining([['x-github-request-id', 'token-request-id']]) });
  expect(result['response.openaiResponses']).toEqual({
    kind: 'error',
    source: 'upstream',
    error: { type: 'error', message: 'access denied' },
  });
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
      input: [{ type: 'message' as const, role: 'user' as const, content: 'retain me' }],
      service_tier: 'priority',
      store: true,
    }),
  }, { services });
  const result = await started.result;
  await started.done;
  const body = wireJson(fetcher.mock.calls[0][1]);
  expect(selectModel).toHaveBeenCalledWith('copilot-1', expect.any(String), 'openaiResponses', expect.objectContaining({ fast: true }));
  expect(body).toMatchObject({
    model: 'raw-model',
    stream: false,
    input: [{ type: 'message', role: 'user', content: 'retain me' }, { type: 'compaction_trigger' }],
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
      images: [{ type: 'upload' as const, file: new File([new Uint8Array([0, 1, 2])], 'test.png', { type: 'image/png' }) }],
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

test('Copilot Decision uses the model dialect on both sides of the HTTP exchange', async () => {
  const request = parseDecisionRequest('typesafe-systemone', {
    model: 'visible-model',
    state: 'Is the test green?',
    questions: { green: { type: 'noul', criteria: { true: 'green', false: 'red' } } },
  }).request;
  const { services, fetcher } = servicesFor(() => Response.json({
    model: 'raw-model',
    answers: [{ name: 'green', type: 'predicate', probability: 0.75 }],
  }));
  const model = { ...stubProviderModel({}), enabledFlags: [], decisionTarget: { protocol: 'openai-decisions' as const } };
  const started = run(copilotPipelines.decision, { ...requestFacts([], model), 'request.decision': move(request) }, { services });
  const result = await started.result;
  await started.done;
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe('https://copilot.test/v1/decisions');
  expect(wireJson(init)).toMatchObject({ model: 'raw-model', questions: [{ name: 'green', type: 'predicate' }] });
  expect(result['response.decision']).toMatchObject({ kind: 'result', result: { answers: [{ name: 'green', type: 'noul', noul: 0.75 }] } });
});
