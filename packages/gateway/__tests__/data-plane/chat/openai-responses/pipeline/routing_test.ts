import { expect, test, vi } from 'vitest';

import { responsesTestServices } from './fixtures.ts';
import { openaiChatCompletionsHttpEntry, openaiResponsesHttpEntry } from '../../../../../src/data-plane/chat/pipeline/index.ts';
import type { Candidate } from '../../../../../src/data-plane/pipeline/facts.ts';
import { initRepo } from '../../../../../src/repo/index.ts';
import { encodeBase64UrlJson } from '../../../../../src/shared/base64url-json.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { candidateFor, hostFor } from '../../../pipeline/fixtures.ts';
import type { Fetcher, HttpHeaders } from '@floway-dev/http';
import { run } from '@floway-dev/pipeline';
import { initExternalResourceFetcher } from '@floway-dev/platform';
import type { FlagId } from '@floway-dev/upstream';

const sse = (...events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
  headers: { 'content-type': 'text/event-stream' },
});

const response = {
  id: 'resp_upstream', object: 'response', model: 'wire-model',
  status: 'completed', output: [], error: null, incomplete_details: null,
};

const candidate = (endpoints: Candidate['model']['endpoints'], enabledFlags: readonly FlagId[] = []): Candidate => {
  const base = candidateFor('responses-upstream');
  return {
    upstream: {
      ...base.upstream,
      config: { baseUrl: 'https://responses.test', apiKey: 'fixture-key', ingressHeadersRules: [], endpoints, modelsFetch: { enabled: false, authStyle: 'bearer' } },
    },
    model: { ...base.model, endpoints, enabledFlags },
  };
};

const start = (
  upstream: Candidate,
  fetcher: Fetcher,
  body: object,
  operation: 'openaiResponses' | 'openaiChatCompletions' = 'openaiResponses',
  checkNativeStore = false,
  headers: HttpHeaders = [],
) => {
  initRepo(new InMemoryRepo());
  const defaults = responsesTestServices();
  const catalogCandidates = vi.fn(async () => ({ candidates: [upstream], sawModel: true }));
  const store = vi.fn(defaults.openaiResponsesStore);
  const host = hostFor({
    ...defaults, catalogCandidates, fetcher: () => fetcher,
    openaiResponsesStore: checkNativeStore ? store : defaults.openaiResponsesStore,
  });
  const path = operation === 'openaiResponses' ? '/v1/responses' : '/v1/chat/completions';
  const entry = operation === 'openaiResponses' ? openaiResponsesHttpEntry : openaiChatCompletionsHttpEntry;
  const execution = run(entry, {
    http: { method: 'POST', url: `https://floway.test${path}`, headers, body: new TextEncoder().encode(JSON.stringify(body)) },
    'serve.startedAt': Date.now(),
  }, host.options);
  return {
    catalogCandidates, store,
    async finish() {
      const answer = await execution.result;
      try {
        const { http } = answer;
        if (http === null || !(http.body instanceof Uint8Array)) throw new Error('Expected encoded JSON response');
        return { status: http.status, body: JSON.parse(new TextDecoder().decode(http.body)) as unknown };
      } finally {
        host.controller.abort();
        execution.discard(answer);
        await host.settle();
        expect(host.errors).toEqual([]);
      }
    },
  };
};

test('excludes a chat candidate that has no Responses-compatible endpoint', async () => {
  const fetcher = vi.fn<Fetcher>();
  const request = start(candidate({ geminiGenerateContent: {} }), fetcher, { model: 'public-model', input: 'hello', store: false });
  await expect(request.finish()).resolves.toMatchObject({
    status: 400, body: { error: { message: 'Model public-model does not support the /responses endpoint.' } },
  });
  expect(fetcher).not.toHaveBeenCalled();
});

test('discovers by alias and applies reasoning, verbosity and service-tier rules on the native wire', async () => {
  const fetcher = vi.fn<Fetcher>(async () => sse({ type: 'response.completed', response }));
  const upstream = {
    ...candidate({ openaiResponses: {} }),
    rules: { reasoning: { effort: 'high', summary: 'detailed' }, verbosity: 'medium', serviceTier: 'priority' },
  } satisfies Candidate;
  const request = start(upstream, fetcher, { model: 'alias', input: 'hello', store: false });
  await expect(request.finish()).resolves.toMatchObject({ status: 200 });
  expect(request.catalogCandidates).toHaveBeenCalledExactlyOnceWith({ model: 'alias', kind: 'chat' });
  const [, init] = fetcher.mock.calls[0];
  if (typeof init.body !== 'string') throw new TypeError('Expected upstream Responses JSON');
  expect(JSON.parse(init.body)).toMatchObject({
    model: 'wire-model', reasoning: { effort: 'high', summary: 'detailed' }, text: { verbosity: 'medium' }, service_tier: 'priority',
  });
});

test('translates standalone output to user context and applies role policy at the Chat Completions destination', async () => {
  const fetcher = vi.fn<Fetcher>(async () => sse({
    id: 'cc_wire', object: 'chat.completion.chunk', created: 1, model: 'wire-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  }));
  const request = start(candidate({ openaiChatCompletions: {} }, ['rewrite-system-to-developer']), fetcher, {
    model: 'public-model', store: false, input: [
      { type: 'message', role: 'system', content: 'rules' },
      { type: 'function_call_output', name: 'goal_objective', output: 'objective text' },
    ],
  });
  await expect(request.finish()).resolves.toMatchObject({ status: 200 });
  const [, init] = fetcher.mock.calls[0];
  if (typeof init.body !== 'string') throw new TypeError('Expected upstream Chat Completions JSON');
  const { messages } = JSON.parse(init.body);
  expect(messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'developer' }),
    expect.objectContaining({ role: 'user', content: expect.stringContaining('<external_goal_objective>') }),
  ]));
});

test('a translated arrival in the Responses body leaves the native Responses store untouched', async () => {
  const finish = {
    ...response, output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }],
  };
  const fetcher = vi.fn<Fetcher>(async () => sse({ type: 'response.completed', response: finish }));
  const request = start(candidate({ openaiResponses: {} }), fetcher, {
    model: 'public-model', messages: [{ role: 'user', content: 'hello' }],
  }, 'openaiChatCompletions', true);
  await expect(request.finish()).resolves.toMatchObject({ status: 200 });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(request.store).not.toHaveBeenCalled();
});

test('translation states the remote image URL on the Anthropic wire without forwarding Responses headers', async () => {
  const external = vi.fn((): never => { throw new Error('Unexpected image fetch'); });
  initExternalResourceFetcher(external);
  const fetcher = vi.fn<Fetcher>(async (_url, init) => {
    const headers = new Headers(init.headers);
    expect(headers.get('anthropic-beta')).toBeNull();
    expect(headers.get('x-test')).toBeNull();
    expect(JSON.parse(String(init.body))).toMatchObject({
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.test/image.png' } }] }],
    });
    return sse(
      { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'wire-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'message_stop' },
    );
  });
  const request = start(candidate({ anthropicMessages: {} }), fetcher, {
    model: 'public-model', store: false,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'https://example.test/image.png', detail: 'auto' }] }],
  }, 'openaiResponses', false, [['anthropic-beta', 'source-only'], ['x-test', 'discard']]);
  await expect(request.finish()).resolves.toMatchObject({ status: 200 });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(external).not.toHaveBeenCalled();
});

test('applies namespace wire mapping to expanded compact history and restores the client identity', async () => {
  const namespace = { type: 'namespace', name: 'files', description: '', tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }] };
  const history = { type: 'function_call', name: 'read', namespace: 'files', call_id: 'past', arguments: '{}', status: 'completed' };
  const request = {
    model: 'public-model', store: false,
    tools: [{ type: 'function', name: 'files_read' }, namespace],
    input: [{ type: 'compaction', encrypted_content: encodeBase64UrlJson([history, { type: 'function_call_output', call_id: 'past', output: 'done' }]) }],
  };
  const fetcher = vi.fn<Fetcher>(async (_url, init) => {
    const body = JSON.parse(String(init.body));
    expect(body.tools).toEqual(expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: 'files_read_2' }) })]));
    expect(JSON.stringify(body.messages)).toContain('files_read_2');
    return sse({
      id: 'chat_return', object: 'chat.completion.chunk', created: 1, model: 'wire-model',
      choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'next', type: 'function', function: { name: 'files_read_2', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
    });
  });
  const run = start(candidate({ openaiChatCompletions: {} }), fetcher, request);
  await expect(run.finish()).resolves.toMatchObject({
    status: 200,
    body: { output: expect.arrayContaining([expect.objectContaining({ type: 'function_call', name: 'read', namespace: 'files' })]) },
  });
});
