import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createWireFetch,
  generationOptions,
  type PlaygroundApi,
  type PlaygroundAssistantOutput,
  type PlaygroundMessage,
} from '../../../src/components/playground/request';
import { streamPlaygroundText } from '../../../src/components/playground/stream';

afterEach(() => vi.unstubAllGlobals());

const sseBody = (events: readonly (object | string)[]): string =>
  `${events.map(event => {
    const data = typeof event === 'string' ? event : JSON.stringify(event);
    return typeof event === 'object' && 'type' in event ? `event: ${event.type}\ndata: ${data}` : `data: ${data}`;
  }).join('\n\n')}\n\n`;

const collect = async (stream: AsyncGenerator<string>): Promise<string> => {
  let text = '';
  for await (const delta of stream) text += delta;
  return text;
};

const collectWithOutput = async (
  stream: ReturnType<typeof streamPlaygroundText>,
): Promise<{ text: string; output: PlaygroundAssistantOutput | null }> => {
  let text = '';
  while (true) {
    const next = await stream.next();
    if (next.done) return { text, output: next.value };
    text += next.value;
  }
};

const roundTrip = async (
  api: PlaygroundApi,
  events: readonly (object | string)[],
): Promise<Record<string, unknown>> => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(sseBody(events), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });

  const base = {
    api,
    apiKey: 'secret',
    model: 'test-model',
    system: '',
    options: generationOptions(api, undefined),
    signal: new AbortController().signal,
    fetchImpl: createWireFetch({}, api),
  };
  const first = await collectWithOutput(streamPlaygroundText({
    ...base,
    messages: [{ id: 'user-1', role: 'user', text: 'hello' }],
  }));
  expect(first.text).toBe('ok');
  expect(first.output).not.toBeNull();

  const messages: PlaygroundMessage[] = [
    { id: 'user-1', role: 'user', text: 'hello' },
    { id: 'assistant-1', role: 'assistant', text: first.text, assistantOutput: first.output ?? undefined },
    { id: 'user-2', role: 'user', text: 'again' },
  ];
  await collectWithOutput(streamPlaygroundText({ ...base, messages }));
  return bodies[1]!;
};

describe('playground wire requests', () => {
  it.each([
    {
      name: 'OpenAI Responses',
      api: 'openaiResponses' as const,
      path: '/v1/responses',
      custom: { seed: 9 },
      events: [
        { type: 'response.created', sequence_number: 0, response: { id: 'resp_1', object: 'response', created_at: 1, model: 'test-model', status: 'in_progress', output: [], error: null, incomplete_details: null } },
        { type: 'response.output_text.delta', sequence_number: 1, item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'ok' },
        { type: 'response.completed', sequence_number: 2, response: { id: 'resp_1', object: 'response', created_at: 1, model: 'test-model', status: 'completed', output: [], error: null, incomplete_details: null } },
      ],
    },
    {
      name: 'OpenAI Chat Completions',
      api: 'openaiChatCompletions' as const,
      path: '/v1/chat/completions',
      custom: { seed: 9 },
      events: [
        { id: 'chat_1', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{  index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
        { id: 'chat_1', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{  index: 0, delta: {}, finish_reason: 'stop' }] },
        '[DONE]',
      ],
    },
    {
      name: 'Anthropic Messages',
      api: 'anthropicMessages' as const,
      path: '/v1/messages',
      custom: { metadata: { test: true } },
      events: [
        { type: 'message_start', message: { container: null, diagnostics: null, stop_details: null, id: 'msg_1', type: 'message', role: 'assistant', model: 'test-model', content: [], stop_reason: null, stop_sequence: null, usage: { cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, output_tokens_details: null, server_tool_use: null, service_tier: null } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_stop' },
      ],
    },
  ])('streams text from $name, posts to its own path and sets stream true', async ({ api, custom, events, path }) => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(sseBody(events), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });

    const text = await collect(streamPlaygroundText({
      api,
      apiKey: 'secret',
      model: 'test-model',
      system: '',
      messages: [{ id: '1', role: 'user', text: 'hello' }],
      options: generationOptions(api, undefined),
      signal: new AbortController().signal,
      fetchImpl: createWireFetch(custom, api),
    }));

    expect(text).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(path);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({ model: 'test-model', stream: true, ...generationOptions(api, undefined), ...custom });
  });

  it('replays Responses reasoning items in their original output order', async () => {
    const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'encrypted-reasoning' };
    const message = {
      type: 'message',
      id: 'msg_1',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'ok', annotations: [] }],
    };
    const body = await roundTrip('openaiResponses', [
      { type: 'response.output_text.delta', sequence_number: 0, item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'ok' },
      {
        type: 'response.completed',
        sequence_number: 1,
        response: {
          id: 'resp_1', object: 'response', created_at: 1, model: 'test-model', status: 'completed',
          output: [reasoning, message], error: null, incomplete_details: null,
        },
      },
    ]);

    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: 'hello' },
      reasoning,
      message,
      { type: 'message', role: 'user', content: 'again' },
    ]);
  });

  it('replays Chat Completions reasoning fields without rendering them as text', async () => {
    const reasoningItems = [{ type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'summary' }] }];
    const body = await roundTrip('openaiChatCompletions', [
      {
        id: 'chat_1', object: 'chat.completion.chunk', created: 1, model: 'test-model',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant', content: 'ok', reasoning_text: 'hidden thought',
            reasoning_opaque: 'opaque-reasoning', reasoning_items: reasoningItems,
          },
          finish_reason: null,
        }],
      },
      {
        id: 'chat_1', object: 'chat.completion.chunk', created: 1, model: 'test-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
      '[DONE]',
    ]);

    expect(body.messages).toEqual([
      { role: 'user', content: 'hello' },
      {
        role: 'assistant', content: 'ok', reasoning_text: 'hidden thought',
        reasoning_opaque: 'opaque-reasoning', reasoning_items: reasoningItems, refusal: null,
      },
      { role: 'user', content: 'again' },
    ]);
  });

  it('replays Messages thinking and signature blocks without rendering them as text', async () => {
    const body = await roundTrip('anthropicMessages', [
      {
        type: 'message_start',
        message: {
          id: 'msg_1', type: 'message', role: 'assistant', model: 'test-model', content: [],
          stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hidden thought' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed-reasoning' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]);

    expect(body.messages).toEqual([
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hidden thought', signature: 'signed-reasoning' },
          { type: 'text', text: 'ok', citations: null },
        ],
      },
      { role: 'user', content: 'again' },
    ]);
  });

  it('falls back to visible assistant text when the saved output belongs to another API', async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(sseBody([
        {
          id: 'chat_1', object: 'chat.completion.chunk', created: 1, model: 'test-model',
          choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
        },
        '[DONE]',
      ]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });

    await collectWithOutput(streamPlaygroundText({
      api: 'openaiChatCompletions',
      apiKey: 'secret',
      model: 'test-model',
      system: '',
      messages: [{
        id: 'assistant-1',
        role: 'assistant',
        text: 'visible answer',
        assistantOutput: { api: 'openaiResponses', items: [{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'secret' }] },
      }],
      options: {},
      signal: new AbortController().signal,
      fetchImpl: createWireFetch({}, 'openaiChatCompletions'),
    }));

    expect(calls[0]!.messages).toEqual([{ role: 'assistant', content: 'visible answer' }]);
  });

  it('sends the API key the way each protocol authenticates', async () => {
    const headers: HeadersInit[] = [];
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers.push(init?.headers ?? {});
      return new Response(sseBody(['[DONE]']), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });

    const request = {
      apiKey: 'secret',
      model: 'test-model',
      system: '',
      messages: [{ id: '1', role: 'user' as const, text: 'hello' }],
      options: {},
      signal: new AbortController().signal,
    };
    await collect(streamPlaygroundText({ ...request, api: 'anthropicMessages', fetchImpl: createWireFetch({}, 'anthropicMessages') }));
    await collect(streamPlaygroundText({ ...request, api: 'openaiChatCompletions', fetchImpl: createWireFetch({}, 'openaiChatCompletions') }));

    expect(headers[0]).toMatchObject({ 'x-api-key': 'secret' });
    expect(headers[1]).toMatchObject({ authorization: 'Bearer secret' });
  });

  it('surfaces an error frame instead of returning empty text', async () => {
    vi.stubGlobal('fetch', async () => new Response(
      sseBody([{ error: { message: 'upstream refused' } }]),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));

    await expect(collect(streamPlaygroundText({
      api: 'openaiChatCompletions',
      apiKey: 'secret',
      model: 'test-model',
      system: '',
      messages: [{ id: '1', role: 'user', text: 'hello' }],
      options: {},
      signal: new AbortController().signal,
      fetchImpl: createWireFetch({}, 'openaiChatCompletions'),
    }))).rejects.toThrow('upstream refused');
  });

  it('surfaces an OpenAI Responses failed envelope instead of returning empty text', async () => {
    vi.stubGlobal('fetch', async () => new Response(
      sseBody([{
        type: 'response.failed',
        response: {
          id: 'resp_1',
          object: 'response',
          created_at: 1,
          model: 'test-model',
          status: 'failed',
          output: [],
          error: { code: 'server_error', message: 'generation failed' },
          incomplete_details: null,
        },
      }]),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));

    await expect(collect(streamPlaygroundText({
      api: 'openaiResponses',
      apiKey: 'secret',
      model: 'test-model',
      system: '',
      messages: [{ id: '1', role: 'user', text: 'hello' }],
      options: {},
      signal: new AbortController().signal,
      fetchImpl: createWireFetch({}, 'openaiResponses'),
    }))).rejects.toThrow('generation failed');
  });

  it('surfaces a non-2xx body rather than a bare status', async () => {
    vi.stubGlobal('fetch', async () => new Response(
      JSON.stringify({ error: { message: 'no such model' } }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    ));

    await expect(collect(streamPlaygroundText({
      api: 'openaiResponses',
      apiKey: 'secret',
      model: 'missing',
      system: '',
      messages: [{ id: '1', role: 'user', text: 'hello' }],
      options: {},
      signal: new AbortController().signal,
      fetchImpl: createWireFetch({}, 'openaiResponses'),
    }))).rejects.toThrow('no such model');
  });
});
