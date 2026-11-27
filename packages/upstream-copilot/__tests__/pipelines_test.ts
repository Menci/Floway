import { expect, it, vi } from 'vitest';

import { copilotPipelines, createCopilotServices } from '../src/index.ts';
import type { CopilotServices } from '../src/service.ts';
import { emptyCopilotUpstreamState, readCopilotUpstreamState } from '../src/state.ts';
import { HttpTransportError, type Fetcher, type FetchInit, type HttpRequestFact } from '@floway-dev/http';
import { asEntry, run } from '@floway-dev/pipeline';
import { PROMPT_TOO_LONG_MESSAGE } from '@floway-dev/protocols/anthropic-messages';
import { parseDecisionRequest } from '@floway-dev/protocols/decision';
import { initUpstreamRuntimeRepo, toUpstreamSnapshot, type UpstreamModelSnapshot, type UpstreamPipeline, type UpstreamRecord, type UpstreamRequest, type UpstreamOperation } from '@floway-dev/upstream';

const record: UpstreamRecord = {
  id: 'copilot-test',
  kind: 'copilot',
  name: 'Copilot',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '',
  updatedAt: '',
  config: { githubHost: 'github.com', githubToken: 'test-github-token', user: { login: 'test', id: 1, name: null, avatar_url: '' } },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  hue: 0,
};

const baseHttp: HttpRequestFact = {
  method: 'POST',
  url: 'https://floway.test/v1/messages',
  headers: [['authorization', 'client-credential'], ['x-client-secret', 'client-value']],
  body: new Uint8Array([0]),
};

const baseModel: UpstreamModelSnapshot = {
  id: 'claude-opus-4.7',
  upstreamModelId: 'claude-opus-4.7',
  kind: 'chat',
  limits: {},
  endpoints: { openaiChatCompletions: {}, openaiResponses: {}, anthropicMessages: {}, openaiEmbeddings: {} },
  enabledFlags: [],
  opaqueBlobCompatibilityScope: { bindToUpstream: true },
  upstreamData: {
    rawModels: [
      { id: 'claude-opus-4.7', supported_endpoints: ['/chat/completions', '/responses', '/v1/messages', '/embeddings'] },
      { id: 'claude-opus-4.7-1m-internal', supported_endpoints: ['/v1/messages'], capabilities: { supports: { reasoning_effort: ['high'] } } },
    ],
  },
};

const base = { upstream: toUpstreamSnapshot(record), model: baseModel, http: baseHttp };
const replacementConfig = {
  githubHost: 'github.com',
  githubToken: 'replacement-github-token',
  user: { login: 'replacement', id: 2, name: null, avatar_url: '' },
};
const quotaHeaders = {
  'x-quota-snapshot-premium_interactions': 'ent=300&ov=0.0&ovPerm=false&rem=90.0&rst=2026-09-01T00%3A00%3A00Z&totRem=270',
};

const start = <Op extends UpstreamOperation, Optional extends 'usageModelKey' = never>(
  pipeline: UpstreamPipeline<Op, CopilotServices, Optional>,
  facts: UpstreamRequest<Op>,
  fetcher: Fetcher,
  signal = new AbortController().signal,
) => {
  const background: Promise<unknown>[] = [];
  const handle = run(asEntry(pipeline), facts, {
    services: createCopilotServices({ fetcher: () => fetcher }),
    signal,
    waitUntil: task => { background.push(task); },
  });
  return { handle, background };
};

const setRepo = (token = true, live = { config: record.config, version: 1 }) => {
  const state = {
    ...emptyCopilotUpstreamState(),
    copilotToken: token ? { token: 'test-copilot-token', expiresAt: Math.floor(Date.now() / 1000) + 3600, baseUrl: 'https://copilot.test' } : null,
  };
  let current = { ...record, state, ...live };
  const saveState = vi.fn(async (_id: string, mutate: (state: unknown, version: number) => unknown) => {
    current = { ...current, state: readCopilotUpstreamState(mutate(current.state, current.version)) };
  });
  const recordUpstreamMetric = vi.fn(async () => {});
  initUpstreamRuntimeRepo(() => ({
    recordUpstreamMetric,
    upstreams: { getById: async () => current, saveState },
  }));
  return {
    saveState,
    recordUpstreamMetric,
    state: () => current.state,
    incrementVersion() { current = { ...current, version: current.version + 1 }; },
    replaceConfiguration() {
      current = { ...current, config: replacementConfig, state: emptyCopilotUpstreamState(), version: current.version + 1 };
    },
  };
};

const sse = (body: string) => new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });

it('refreshes credentials through the candidate fetcher and skips a stale state write', async () => {
  const repo = setRepo(false);
  const fetcher = vi.fn(async (url: string, init: FetchInit) => {
    const headers = new Headers(init.headers);
    if (url === 'https://api.github.com/copilot_internal/v2/token') {
      expect(headers.get('authorization')).toBe('token test-github-token');
      repo.incrementVersion();
      return Response.json({ token: 'refreshed', expires_at: Math.floor(Date.now() / 1000) + 3600, endpoints: { api: 'https://copilot.test' } });
    }

    expect(url).toBe('https://copilot.test/embeddings');
    expect(headers.get('authorization')).toBe('Bearer refreshed');
    expect(headers.has('x-client-secret')).toBe(false);
    expect(headers.get('x-request-id')).toBe(headers.get('x-agent-task-id'));
    expect(init.body).toBe('{"model":"claude-opus-4.7","input":["text"]}');
    return Response.json({ data: [] });
  });
  const { handle } = start(copilotPipelines.openaiEmbeddings, {
    ...base,
    openaiEmbeddings: { model: 'alias', input: 'text' },
  }, fetcher);

  const answer = await handle.result;
  expect(answer.openaiEmbeddings).toEqual({ kind: 'result', result: { data: [] } });
  expect(answer).not.toHaveProperty('usageModelKey');
  expect(answer.http).toMatchObject({ status: 200, body: null });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(repo.saveState).toHaveBeenCalledTimes(1);
  expect(repo.state().copilotToken).toBeNull();
  handle.discard(answer);
});

it.each([false, true])('uses the candidate Copilot PAT after a config change (current token present: %s)', async hasToken => {
  const repo = setRepo(hasToken, {
    config: replacementConfig,
    version: 2,
  });
  const fetcher = vi.fn(async (url: string, init: FetchInit) => {
    const headers = new Headers(init.headers);
    if (url === 'https://api.github.com/copilot_internal/v2/token') {
      expect(headers.get('authorization')).toBe('token test-github-token');
      return Response.json({
        token: 'candidate-copilot-token',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        endpoints: { api: 'https://candidate-copilot.test' },
      });
    }

    expect(url).toBe('https://candidate-copilot.test/embeddings');
    expect(headers.get('authorization')).toBe('Bearer candidate-copilot-token');
    expect(init.body).toBe('{"model":"claude-opus-4.7","input":["text"]}');
    return Response.json({ data: [] });
  });
  const { handle } = start(copilotPipelines.openaiEmbeddings, {
    ...base,
    openaiEmbeddings: { model: 'alias', input: 'text' },
  }, fetcher);

  const answer = await handle.result;
  expect(answer.openaiEmbeddings).toEqual({ kind: 'result', result: { data: [] } });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(repo.saveState).not.toHaveBeenCalled();
  expect(repo.state().copilotToken?.token).toBe(hasToken ? 'test-copilot-token' : undefined);
  handle.discard(answer);
});

it('selects the Anthropic context variant, normalizes beta and persists quota independently', async () => {
  const repo = setRepo();
  const writeStarted = Promise.withResolvers<void>();
  const writeGate = Promise.withResolvers<void>();
  const saveState = repo.saveState.getMockImplementation()!;
  repo.saveState.mockImplementation(async (...args) => {
    writeStarted.resolve();
    await writeGate.promise;
    await saveState(...args);
  });
  const { handle, background } = start(copilotPipelines.anthropicMessagesCountTokens, {
    ...base,
    http: { ...baseHttp, headers: [['anthropic-beta', 'context-1m-2025-08-07'], ['Anthropic-Beta', 'advanced-tool-use-2025-11-20,unknown-extension']] },
    anthropicMessagesCountTokens: { model: 'alias', output_config: { effort: 'high' }, messages: [{ role: 'user', content: 'hello' }] },
  }, async (url, init) => {
    expect(url).toBe('https://copilot.test/v1/messages/count_tokens');
    expect(new Headers(init.headers).get('anthropic-beta')).toBe('advanced-tool-use-2025-11-20');
    expect(init.body).toContain('"model":"claude-opus-4.7-1m-internal"');
    return Response.json({ input_tokens: 7 }, { headers: quotaHeaders });
  });

  const answer = await handle.result;
  expect(answer.anthropicMessagesCountTokens).toEqual({ kind: 'result', result: { input_tokens: 7 } });
  expect(answer).not.toHaveProperty('usageModelKey');
  await writeStarted.promise;
  expect(repo.saveState).toHaveBeenCalledTimes(1);
  expect(background).toHaveLength(1);
  expect(repo.state().quotaSnapshot).toBeNull();
  handle.discard(answer);
  writeGate.resolve();
  await Promise.all(background);
  expect(repo.state().quotaSnapshot).not.toBeNull();
  expect(repo.recordUpstreamMetric).toHaveBeenCalled();
});

it.each(['before headers', 'during the quota CAS'])('keeps old-account quota out of the replacement configuration %s', async when => {
  const repo = setRepo();
  const dialStarted = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const writeStarted = Promise.withResolvers<void>();
  const writeGate = Promise.withResolvers<void>();
  if (when === 'during the quota CAS') {
    const saveState = repo.saveState.getMockImplementation()!;
    repo.saveState.mockImplementation(async (...args) => {
      writeStarted.resolve();
      await writeGate.promise;
      await saveState(...args);
    });
  }
  const { handle, background } = start(copilotPipelines.openaiEmbeddings, {
    ...base,
    openaiEmbeddings: { model: 'alias', input: 'text' },
  }, async (url, init) => {
    expect(url).toBe('https://copilot.test/embeddings');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-copilot-token');
    dialStarted.resolve();
    return await response.promise;
  });
  await dialStarted.promise;
  if (when === 'before headers') repo.replaceConfiguration();
  response.resolve(Response.json({ data: [] }, { headers: quotaHeaders }));
  const answer = await handle.result;
  expect(answer.openaiEmbeddings).toEqual({ kind: 'result', result: { data: [] } });
  expect(background).toHaveLength(1);
  handle.discard(answer);
  if (when === 'during the quota CAS') {
    await writeStarted.promise;
    repo.replaceConfiguration();
    writeGate.resolve();
  }
  await Promise.all(background);
  expect(repo.state().quotaSnapshot).toBeNull();
  expect(repo.recordUpstreamMetric).not.toHaveBeenCalled();
});

it.each([204, 205])('preserves a bodyless Count Tokens success with status %i', async status => {
  setRepo();
  const { handle } = start(copilotPipelines.anthropicMessagesCountTokens, {
    ...base,
    anthropicMessagesCountTokens: { model: 'alias', messages: [] },
  }, async url => {
    expect(url).toBe('https://copilot.test/v1/messages/count_tokens');
    return new Response(null, { status });
  });
  const answer = await handle.result;
  expect(answer.http).toMatchObject({ status, body: null });
  expect(answer.anthropicMessagesCountTokens).toEqual({ kind: 'result', result: null });
  handle.discard(answer);
});

it.each([
  [{ total_tokens: 17, vendor_field: 'retained' }, 17],
  [{ total_tokens: 17, input_tokens: 4 }, 4],
  [{ total_tokens: 17, input_tokens: -1 }, 17],
  [{ total_tokens: -1 }, null],
] as const)('normalizes the Copilot Count Tokens payload %j', async (body, inputTokens) => {
  setRepo();
  const { handle } = start(copilotPipelines.anthropicMessagesCountTokens, {
    ...base,
    anthropicMessagesCountTokens: { model: 'alias', messages: [] },
  }, async url => {
    expect(url).toBe('https://copilot.test/v1/messages/count_tokens');
    return Response.json(body);
  });
  const answer = await handle.result;
  expect(answer.anthropicMessagesCountTokens).toMatchObject(inputTokens === null
    ? { kind: 'error', source: 'upstream' }
    : { kind: 'result', result: { ...body, input_tokens: inputTokens } });
  handle.discard(answer);
});

it('rejects unavailable Anthropic fast mode before authorization with a local outcome', async () => {
  const fetcher = vi.fn<Fetcher>();
  const { handle } = start(copilotPipelines.anthropicMessages, {
    ...base,
    anthropicMessages: { model: 'alias', max_tokens: 64, messages: [], speed: 'fast' },
  }, fetcher);
  const answer = await handle.result;
  expect(answer.anthropicMessages).toEqual({
    kind: 'error',
    source: 'local',
    error: { type: 'error', error: { type: 'invalid_request_error', message: "'claude-opus-4.7' does not support the `speed` parameter." } },
  });
  expect(answer.http?.status).toBe(400);
  expect(answer).not.toHaveProperty('usageModelKey');
  expect(fetcher).not.toHaveBeenCalled();
  handle.discard(answer);
});

it('selects the Anthropic fast variant and reports speed on the initial usage', async () => {
  setRepo();
  const model: UpstreamModelSnapshot = {
    ...baseModel,
    upstreamData: {
      rawModels: [
        { id: 'claude-opus-4.7', supported_endpoints: ['/v1/messages'] },
        { id: 'claude-opus-4.7-fast', supported_endpoints: ['/v1/messages'] },
      ],
    },
  };
  const { handle } = start(copilotPipelines.anthropicMessages, {
    ...base,
    model,
    anthropicMessages: { model: 'alias', max_tokens: 32, messages: [], speed: 'fast' },
  }, async (url, init) => {
    expect(url).toBe('https://copilot.test/v1/messages');
    expect(init.body).toBe('{"model":"claude-opus-4.7-fast","max_tokens":32,"messages":[],"stream":true}');
    return sse([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_fast","type":"message","role":"assistant","content":[],"model":"claude-opus-4.7-fast","usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join(''));
  });
  const answer = await handle.result;
  expect(answer.usageModelKey).toBe('claude-opus-4.7-fast');
  if (answer.anthropicMessages.kind !== 'stream') throw new Error('Expected Anthropic Messages stream');
  const items = [];
  for await (const item of handle.read(answer.anthropicMessages.stream)) items.push(item);
  expect(items[0]).toMatchObject({ ok: true, value: { type: 'message_start', message: { usage: { speed: 'fast' } } } });
  expect(items[1]).toMatchObject({ ok: true, value: { type: 'message_delta', usage: { output_tokens: 7 } } });
  expect(items[1]).not.toHaveProperty('value.usage.speed');
  expect(items[2]).toMatchObject({ ok: true, value: { type: 'message_stop' } });
  handle.discard(answer);
});

it('maps the Copilot context-window error to the Anthropic compaction trigger', async () => {
  setRepo();
  const { handle } = start(copilotPipelines.anthropicMessages, {
    ...base,
    anthropicMessages: { model: 'alias', max_tokens: 32, messages: [] },
  }, async () => new Response('Request body is too large for model context window', {
    status: 413,
    headers: { 'x-upstream': 'test' },
  }));
  const answer = await handle.result;
  expect(answer.http).toMatchObject({
    status: 400,
    headers: expect.arrayContaining([['content-type', 'application/json'], ['x-upstream', 'test']]),
    body: null,
  });
  expect(answer.anthropicMessages).toMatchObject({
    kind: 'error',
    source: 'upstream',
    error: { error: { message: PROMPT_TOO_LONG_MESSAGE } },
  });
  handle.discard(answer);
});

it('finishes chat at native EOF and renders an excessive tool whitespace error as a stream item', async () => {
  setRepo();
  const request = { ...base, openaiChatCompletions: { model: 'alias', messages: [] } };
  const chunk = { id: 'test', object: 'chat.completion.chunk', created: 1, model: 'alias', choices: [] };
  const normal = start(copilotPipelines.openaiChatCompletions, request, async () => sse(`data: ${JSON.stringify(chunk)}\n\n`));
  const answer = await normal.handle.result;
  const { openaiChatCompletions: outcome } = answer;
  if (outcome.kind !== 'stream') throw new Error('Expected Chat Completions stream');
  const cursor = normal.handle.read(outcome.stream);
  expect((await cursor.next()).value).toEqual({ ok: true, value: chunk });
  expect((await cursor.next()).done).toBe(true);
  normal.handle.discard(answer);

  const malformed = {
    ...chunk,
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '\t'.repeat(21) } }] }, finish_reason: null }],
  };
  const guarded = start(copilotPipelines.openaiChatCompletions, request, async () => sse(`data: ${JSON.stringify(malformed)}\n\ndata: [DONE]\n\n`));
  const guardedAnswer = await guarded.handle.result;
  if (guardedAnswer.openaiChatCompletions.kind !== 'stream') throw new Error('Expected guarded Chat Completions stream');
  const badCursor = guarded.handle.read(guardedAnswer.openaiChatCompletions.stream);
  expect((await badCursor.next()).value).toMatchObject({ ok: false, error: { kind: 'protocol' } });
  expect((await badCursor.next()).done).toBe(true);
  guarded.handle.discard(guardedAnswer);
  await Promise.all(guarded.background);
});

it('preserves ordinary error bodies and distinguishes transport, abort and panic', async () => {
  setRepo();
  const request = { ...base, openaiEmbeddings: { model: 'alias', input: 'text' } };
  const httpFailure = start(copilotPipelines.openaiEmbeddings, request, async () => new Response('upstream says no', {
    status: 429,
    headers: { 'retry-after': '32' },
  }));
  const httpAnswer = await httpFailure.handle.result;
  expect(httpAnswer.http).toMatchObject({ status: 429, headers: expect.arrayContaining([['retry-after', '32']]), body: null });
  expect(httpAnswer.openaiEmbeddings).toMatchObject({ kind: 'error', source: 'upstream', error: { error: { message: 'upstream says no' } } });
  httpFailure.handle.discard(httpAnswer);

  const failed = start(copilotPipelines.openaiEmbeddings, request, async () => { throw new HttpTransportError('broken dial'); });
  const failedAnswer = await failed.handle.result;
  expect(failedAnswer).toMatchObject({ http: null, openaiEmbeddings: { kind: 'error', source: 'upstream' } });
  failed.handle.discard(failedAnswer);

  const abortedFetcher = vi.fn<Fetcher>();
  const cancelled = start(copilotPipelines.openaiEmbeddings, request, abortedFetcher, AbortSignal.abort(new Error('stop')));
  const cancelledAnswer = await cancelled.handle.result;
  expect(cancelledAnswer).toMatchObject({ http: null, openaiEmbeddings: { kind: 'error', source: 'local' } });
  expect(cancelledAnswer).not.toHaveProperty('usageModelKey');
  expect(abortedFetcher).not.toHaveBeenCalled();
  cancelled.handle.discard(cancelledAnswer);

  const panic = new TypeError('unexpected fetcher defect');
  const broken = start(copilotPipelines.openaiEmbeddings, request, async () => { throw panic; });
  await expect(broken.handle.result).rejects.toBe(panic);
});

it('runs Responses compact over the trigger turn and protects opaque item identity', async () => {
  setRepo();
  const { handle } = start(copilotPipelines.openaiResponsesCompact, {
    ...base,
    openaiResponsesCompact: {
      model: 'alias',
      input: [{ role: 'user', type: 'message', content: [{ type: 'input_text', text: 'keep me' }] }],
      service_tier: 'priority',
      store: true,
    },
  }, async (url, init) => {
    expect(url).toBe('https://copilot.test/responses');
    expect(init.body).toBe('{"model":"claude-opus-4.7","input":[{"role":"user","type":"message","content":[{"type":"input_text","text":"keep me"}]},{"type":"compaction_trigger"}],"stream":false}');
    return Response.json({
      id: 'resp_test',
      object: 'response',
      output: [{ id: 'upstream-compaction-id', type: 'compaction', encrypted_content: 'upstream-encrypted' }],
    });
  });

  const answer = await handle.result;
  expect(answer.openaiResponsesCompact).toMatchObject({
    kind: 'result',
    result: {
      object: 'response.compaction', output: [
        { type: 'message', content: [{ type: 'input_text', text: 'keep me' }] },
        { type: 'compaction' },
      ],
    },
  });
  const outcome = answer.openaiResponsesCompact;
  if (outcome.kind !== 'result') throw new Error('Expected compact result');
  expect(outcome.result.output[1]).not.toMatchObject({ id: 'upstream-compaction-id' });
  expect(outcome.result.output[1]).not.toMatchObject({ encrypted_content: 'upstream-encrypted' });
  handle.discard(answer);
});

it('selects the Responses fast wire lane without forwarding the service tier field', async () => {
  setRepo();
  const model: UpstreamModelSnapshot = {
    ...baseModel,
    id: 'gpt-test',
    upstreamModelId: 'gpt-test',
    upstreamData: {
      rawModels: [
        { id: 'gpt-test', supported_endpoints: ['/responses'] },
        { id: 'gpt-test-fast', supported_endpoints: ['/responses'] },
      ],
    },
  };
  const { handle } = start(copilotPipelines.openaiResponses, {
    ...base,
    model,
    openaiResponses: { model: 'alias', input: [], service_tier: 'priority' },
  }, async (url, init) => {
    expect(url).toBe('https://copilot.test/responses');
    expect(init.body).toBe('{"model":"gpt-test-fast","input":[],"stream":true}');
    return sse('data: {"type":"response.completed","response":{"id":"resp_fast","status":"completed","output":[],"service_tier":"priority"}}\n\n');
  });
  const answer = await handle.result;
  expect(answer.usageModelKey).toBe('gpt-test-fast');
  if (answer.openaiResponses.kind !== 'stream') throw new Error('Expected Responses stream');
  const items = [];
  for await (const item of handle.read(answer.openaiResponses.stream)) items.push(item);
  expect(items.at(-1)).toMatchObject({ ok: true, value: { type: 'response.completed' } });
  expect(items.every(item => item.ok)).toBe(true);
  handle.discard(answer);
});

it('forwards image edits as multipart uploads and JSON references on the advertised image endpoint', async () => {
  setRepo();
  const model: UpstreamModelSnapshot = {
    ...baseModel,
    id: 'test-image',
    upstreamModelId: 'test-image',
    kind: 'image',
    endpoints: { openaiImagesEdits: {} },
    upstreamData: { rawModels: [{ id: 'test-image', supported_endpoints: ['/v1/images/edits'] }] },
  };
  const uploaded = start(copilotPipelines.openaiImagesEdits, {
    ...base,
    model,
    openaiImagesEdits: {
      images: [{ type: 'upload', file: { name: 'image.png', mediaType: 'image/png', bytes: new Uint8Array([0x89, 0x50]) } }],
      parameters: { prompt: 'change it' },
    },
  }, async (url, init) => {
    expect(url).toBe('https://copilot.test/v1/images/edits');
    const body = init.body;
    if (!(body instanceof Uint8Array)) throw new Error('Expected multipart bytes');
    const form = await new Response(new Uint8Array(body), { headers: new Headers(init.headers) }).formData();
    expect(form.get('prompt')).toBe('change it');
    expect(form.get('model')).toBe('test-image');
    const image = form.get('image');
    if (!(image instanceof File)) throw new Error('Expected image upload');
    expect(image.name).toBe('image.png');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50]));
    return Response.json({ data: [] });
  });
  const uploadedAnswer = await uploaded.handle.result;
  expect(uploadedAnswer.openaiImagesEdits).toEqual({ kind: 'result', result: { data: [] } });
  uploaded.handle.discard(uploadedAnswer);

  const referenced = start(copilotPipelines.openaiImagesEdits, {
    ...base,
    model,
    openaiImagesEdits: {
      images: [{ type: 'reference', reference: { image_url: 'https://example.test/image.png' } }],
      parameters: { prompt: 'change it' },
    },
  }, async (_url, init) => {
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(init.body).toContain('"image_url":"https://example.test/image.png"');
    return Response.json({ error: { message: 'external image URLs are not supported' } }, { status: 400 });
  });
  const referencedAnswer = await referenced.handle.result;
  expect(referencedAnswer.openaiImagesEdits).toEqual({ kind: 'error', source: 'upstream', error: { error: { message: 'external image URLs are not supported' } } });
  referenced.handle.discard(referencedAnswer);
});

it('preserves native and cross-dialect Decision response bytes for metering and validation', async () => {
  setRepo();
  const model: UpstreamModelSnapshot = {
    ...baseModel,
    id: 'microsoft-decision-1',
    upstreamModelId: 'microsoft-decision-1',
    kind: 'decision',
    endpoints: { decision: {} },
    decisionTarget: { protocol: 'typesafe-systemone' },
    upstreamData: { rawModels: [{ id: 'microsoft-decision-1', supported_endpoints: ['/v1/systemone'] }] },
  };
  const { request } = parseDecisionRequest('typesafe-systemone', {
    model: 'alias',
    state: 'The API returns 500 on every call.',
    questions: { team: { type: 'choice', instructions: 'Which team?', criteria: { engineering: 'Bugs', billing: 'Charges' } } },
  });
  const fetcher = (reply: string): Fetcher => async (url, init) => {
    expect(url).toBe('https://copilot.test/v1/systemone');
    expect(init.body).toContain('"model":"microsoft-decision-1"');
    return new Response(reply);
  };
  const nativeBody = 'unrecognized upstream content';
  const native = start(copilotPipelines.decision, { ...base, model, decision: request }, fetcher(nativeBody));
  const nativeAnswer = await native.handle.result;
  expect(nativeAnswer.decision).toEqual({ kind: 'result', result: new TextEncoder().encode(nativeBody) });
  native.handle.discard(nativeAnswer);

  const crossDialectBody = '{ "answers": null, "usage": { "input_tokens": 37 } }';
  const translated = start(copilotPipelines.decision, {
    ...base,
    model,
    decision: { ...request, sourceProtocol: 'openai-decisions' },
  }, fetcher(crossDialectBody));
  const translatedAnswer = await translated.handle.result;
  expect(translatedAnswer).toMatchObject({
    http: { status: 200, body: null },
    decision: { kind: 'result', result: new TextEncoder().encode(crossDialectBody) },
  });
  translated.handle.discard(translatedAnswer);
});

it('applies the operator-selected Mistral wire schema before the Copilot dial', async () => {
  setRepo();
  const { handle } = start(copilotPipelines.openaiChatCompletions, {
    ...base,
    model: { ...baseModel, enabledFlags: ['vendor-mistral'] },
    openaiChatCompletions: {
      model: 'alias',
      messages: [{ role: 'user', content: 'hello' }],
      max_completion_tokens: 60,
      metadata: { trace_id: 'gateway-only' },
    },
  }, async (_url, init) => {
    expect(init.body).toBe('{"model":"claude-opus-4.7","messages":[{"role":"user","content":"hello","copilot_cache_control":{"type":"ephemeral"}}],"max_tokens":60,"stream":true}');
    return sse('data: [DONE]\n\n');
  });
  const answer = await handle.result;
  if (answer.openaiChatCompletions.kind !== 'stream') throw new Error('Expected Chat Completions stream');
  expect((await handle.read(answer.openaiChatCompletions.stream).next()).done).toBe(true);
  handle.discard(answer);
});
