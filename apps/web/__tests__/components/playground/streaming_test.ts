import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWireFetch, generationOptions } from '../../../src/components/playground/request';
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

describe('playground wire requests', () => {
  it.each([
    {
      name: 'Responses',
      api: 'responses' as const,
      path: '/v1/responses',
      custom: { seed: 9 },
      events: [
        { type: 'response.created', sequence_number: 0, response: { id: 'resp_1', object: 'response', created_at: 1, model: 'test-model', status: 'in_progress', output: [], error: null, incomplete_details: null } },
        { type: 'response.output_text.delta', sequence_number: 1, item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'ok' },
        { type: 'response.completed', sequence_number: 2, response: { id: 'resp_1', object: 'response', created_at: 1, model: 'test-model', status: 'completed', output: [], error: null, incomplete_details: null } },
      ],
    },
    {
      name: 'Chat Completions',
      api: 'chatCompletions' as const,
      path: '/v1/chat/completions',
      custom: { seed: 9 },
      events: [
        { id: 'chat_1', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
        { id: 'chat_1', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        '[DONE]',
      ],
    },
    {
      name: 'Messages',
      api: 'messages' as const,
      path: '/v1/messages',
      custom: { metadata: { test: true } },
      events: [
        { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'test-model', content: [], stop_reason: null, stop_sequence: null, usage: {} } },
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
    await collect(streamPlaygroundText({ ...request, api: 'messages', fetchImpl: createWireFetch({}, 'messages') }));
    await collect(streamPlaygroundText({ ...request, api: 'chatCompletions', fetchImpl: createWireFetch({}, 'chatCompletions') }));

    expect(headers[0]).toMatchObject({ 'x-api-key': 'secret' });
    expect(headers[1]).toMatchObject({ authorization: 'Bearer secret' });
  });

  it('surfaces an error frame instead of returning empty text', async () => {
    vi.stubGlobal('fetch', async () => new Response(
      sseBody([{ error: { message: 'upstream refused' } }]),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));

    await expect(collect(streamPlaygroundText({
      api: 'chatCompletions',
      apiKey: 'secret',
      model: 'test-model',
      system: '',
      messages: [{ id: '1', role: 'user', text: 'hello' }],
      options: {},
      signal: new AbortController().signal,
      fetchImpl: createWireFetch({}, 'chatCompletions'),
    }))).rejects.toThrow('upstream refused');
  });

  it('surfaces a Responses failed envelope instead of returning empty text', async () => {
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
      api: 'responses',
      apiKey: 'secret',
      model: 'test-model',
      system: '',
      messages: [{ id: '1', role: 'user', text: 'hello' }],
      options: {},
      signal: new AbortController().signal,
      fetchImpl: createWireFetch({}, 'responses'),
    }))).rejects.toThrow('generation failed');
  });

  it('surfaces a non-2xx body rather than a bare status', async () => {
    vi.stubGlobal('fetch', async () => new Response(
      JSON.stringify({ error: { message: 'no such model' } }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    ));

    await expect(collect(streamPlaygroundText({
      api: 'responses',
      apiKey: 'secret',
      model: 'missing',
      system: '',
      messages: [{ id: '1', role: 'user', text: 'hello' }],
      options: {},
      signal: new AbortController().signal,
      fetchImpl: createWireFetch({}, 'responses'),
    }))).rejects.toThrow('no such model');
  });
});
