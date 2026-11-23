import { expect, test, vi } from 'vitest';

import {
  decodeWebSearchCitationPayload,
  decodeWebSearchResultPayload,
  encodeWebSearchCitationPayload,
  encodeWebSearchResultPayload,
  type AnthropicMessagesWebSearchShimState,
  prepareAnthropicMessagesWebSearchShimRequest,
  rewriteAnthropicMessagesWebSearchEventsToNative,
} from '../../../../../src/data-plane/chat/anthropic-messages/stages/web-search-protocol.ts';
import type { GatewayServices } from '../../../../../src/data-plane/pipeline/services.ts';
import type { WebSearchProvider } from '../../../../../src/data-plane/tools/web-search/types.ts';
import { generateReply, messagesFixture, messagesUpstream, requestPayload } from '../fixture.ts';
import type { TransportFailure } from '@floway-dev/http';
import { anthropicMessagesProtocolFrameToSSEFrame } from '@floway-dev/protocols/anthropic-messages';
import type {
  AnthropicMessagesAssistantContentBlock,
  AnthropicMessagesClientTool,
  AnthropicMessagesPayload,
  AnthropicMessagesResult,
  AnthropicMessagesStreamEventEx,
  AnthropicMessagesTextBlock,
  AnthropicMessagesToolResultBlock,
  AnthropicMessagesToolResultContentBlock,
  AnthropicMessagesUserContentBlock,
} from '@floway-dev/protocols/anthropic-messages';
import { type ProtocolFrame, eventFrame } from '@floway-dev/protocols/common';
import type { ProviderFrame } from '@floway-dev/provider';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

const encodeUnsignedPayload = (payload: unknown): string => btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

const makeNativeReplayPayload = (): AnthropicMessagesPayload => ({
  model: 'claude-test',
  max_tokens: 64,
  tools: [{ name: 'web_search', type: 'web_search_20260209', max_uses: 2 }],
  messages: [
    { role: 'user', content: 'latest React docs' },
    {
      role: 'assistant',
      content: [
        {
          caller: { type: 'direct' },
          type: 'server_tool_use',
          id: 'srvtoolu_1',
          name: 'web_search',
          input: { query: 'latest React docs' },
        },
        {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: [
            {
              type: 'web_search_result',
              url: 'https://react.dev',
              title: 'React',
              encrypted_content: encodeWebSearchResultPayload({
                content: [{ type: 'text', text: 'Official React documentation' }],
              }),
            },
          ],
        },
        {
          type: 'text',
          text: 'Use the React docs.',
          citations: [
            {
              type: 'web_search_result_location',
              url: 'https://react.dev',
              title: 'React',
              encrypted_index: encodeWebSearchCitationPayload({
                search_result_index: 0,
                start_block_index: 0,
                end_block_index: 0,
              }),
              cited_text: 'Official React documentation',
            },
          ],
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_calc_1',
          content: '4',
        },
      ],
    },
  ],
});

const activeAnthropicMessagesWebSearchShimState = (overrides: Partial<Extract<AnthropicMessagesWebSearchShimState, { mode: 'active' }>> = {}): Extract<AnthropicMessagesWebSearchShimState, { mode: 'active' }> => ({
  mode: 'active',
  toolVersion: 'web_search_20260209',
  maxUses: 2,
  priorSearchUseCount: 0,
  requestSearchResultOwnership: [],
  ...overrides,
});

const unusedFetchPage: WebSearchProvider['fetchPage'] = () =>
  Promise.reject(new Error('fetchPage should not be called from messages shim test'));

const searchOnlyProvider = (search: WebSearchProvider['search']): WebSearchProvider => ({
  search,
  fetchPage: unusedFetchPage,
});

const fakeProviderOk: WebSearchProvider = searchOnlyProvider(() =>
  Promise.resolve({
    type: 'ok',
    results: [
      {
        source: 'https://react.dev',
        title: 'React',
        pageAge: '2026-04-01',
        content: [{ type: 'text', text: 'Official React docs' }],
      },
    ],
  }));

const activeProvider = (impl: WebSearchProvider) => impl.search;

const webSearchProvider = (impl: WebSearchProvider): GatewayServices['webSearchProvider'] => Object.assign(
  async () => ({ type: 'enabled' as const, provider: 'tavily' as const, impl }),
  { alphaSearch: async () => ({ enabled: false, upstreamId: '', model: '' }) },
);

const toAsyncIterable = async function* <T>(values: Iterable<T>): AsyncGenerator<T> {
  for (const value of values) {
    yield value;
  }
};

const anthropicMessagesResponseToUpstreamFrames = (response: AnthropicMessagesResult): ProtocolFrame<AnthropicMessagesStreamEventEx>[] => {
  const frames: ProtocolFrame<AnthropicMessagesStreamEventEx>[] = [
    eventFrame({
      type: 'message_start',
      message: {
        container: null, diagnostics: null, stop_details: null,
        id: response.id,
        type: response.type,
        role: response.role,
        content: [],
        model: response.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { ...response.usage, output_tokens: 0 },
      },
    }),
  ];

  response.content.forEach((block, index) => {
    if (block.type !== 'text') {
      throw new Error(`anthropicMessagesResponseToUpstreamFrames only handles text blocks; got ${block.type}`);
    }
    frames.push(eventFrame({
      type: 'content_block_start',
      index,
      content_block: {
        citations: null,
        type: 'text',
        text: '',
        ...(block.citations?.length ? { citations: [] } : {}),
      },
    }));
    for (const citation of block.citations ?? []) {
      frames.push(eventFrame({ type: 'content_block_delta', index, delta: { type: 'citations_delta', citation } }));
    }
    if (block.text.length > 0) {
      frames.push(eventFrame({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }));
    }
    frames.push(eventFrame({ type: 'content_block_stop', index }));
  });

  frames.push(
    eventFrame({
      type: 'message_delta',
      delta: { container: null, stop_details: null, stop_reason: response.stop_reason, stop_sequence: response.stop_sequence },
      usage: { input_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null, server_tool_use: null, output_tokens: response.usage.output_tokens },
    }),
    eventFrame({ type: 'message_stop' }),
  );

  return frames;
};

test('web search shim payload codecs reject foreign payloads and unknown-shape payloads', () => {
  const encryptedContent = encodeWebSearchResultPayload({
    content: [{ type: 'text', text: 'Claude Shannon was born in 1916.' }],
  });

  assertExists(decodeWebSearchResultPayload(encryptedContent));
  assertEquals(decodeWebSearchResultPayload('foreign.payload'), null);

  const encryptedIndex = encodeWebSearchCitationPayload({
    search_result_index: 0,
    start_block_index: 0,
    end_block_index: 0,
  });

  assertEquals(decodeWebSearchCitationPayload(encryptedIndex)?.search_result_index, 0);

  const encodedExtraResult = encodeUnsignedPayload({
    content: [{ type: 'text', text: 'Claude Shannon was born in 1916.' }],
    extra: true,
  });
  assertEquals(decodeWebSearchResultPayload(encodedExtraResult), null);

  assertEquals(
    decodeWebSearchCitationPayload(
      encodeUnsignedPayload({
        search_result_index: 0,
        start_block_index: 2,
        end_block_index: 1,
      }),
    ),
    null,
  );
});

test('prepareAnthropicMessagesWebSearchShimRequest passes in-array role:"system" messages through unchanged', () => {
  // Regression: prepareAnthropicMessagesWebSearchReplay used to assume any non-user
  // message with array content was an assistant turn and rewrite it with
  // role: 'assistant'. After AnthropicMessagesMessage was widened to include
  // AnthropicMessagesSystemMessage, a system message with AnthropicMessagesTextBlock[] content
  // would silently be re-roled. Verify the shim now passes system messages
  // through as-is whether their content is a string or text-block array.
  const payload: AnthropicMessagesPayload = {
    model: 'claude-test',
    max_tokens: 64,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'be terse' },
      {
        role: 'system',
        content: [
          { citations: null, type: 'text', text: 'paragraph A' },
          { citations: null, type: 'text', text: 'paragraph B' },
        ],
      },
      { role: 'user', content: 'who are you' },
    ],
  };

  const prepared = prepareAnthropicMessagesWebSearchShimRequest(payload);

  assertEquals(prepared.type, 'ok');
  if (prepared.type !== 'ok') throw new Error('expected ok result');

  const messages = prepared.payload.messages;
  assertEquals(messages.length, 4);
  assertEquals(messages[1], { role: 'system', content: 'be terse' });
  assertEquals(messages[2], {
    role: 'system',
    content: [
      { citations: null, type: 'text', text: 'paragraph A' },
      { citations: null, type: 'text', text: 'paragraph B' },
    ],
  });
});

test('prepareAnthropicMessagesWebSearchShimRequest decodes our native-looking replay into upstream tool history', () => {
  const prepared = prepareAnthropicMessagesWebSearchShimRequest(makeNativeReplayPayload());

  assertEquals(prepared.type, 'ok');
  if (prepared.type !== 'ok') throw new Error('expected ok result');

  const assistant = prepared.payload.messages[1];
  const user = prepared.payload.messages[2];

  assertEquals((assistant.content as AnthropicMessagesAssistantContentBlock[])[0].type, 'tool_use');
  assertEquals(((assistant.content as AnthropicMessagesAssistantContentBlock[])[1] as AnthropicMessagesTextBlock).citations?.[0]?.type, 'search_result_location');
  assertEquals((((user.content as AnthropicMessagesUserContentBlock[])[0] as AnthropicMessagesToolResultBlock).content as AnthropicMessagesToolResultContentBlock[])[0].type, 'search_result');
  assertEquals((user.content as AnthropicMessagesUserContentBlock[]).length, 2);
  assertEquals(prepared.state.mode, 'active');
  if (prepared.state.mode !== 'active') {
    throw new Error('expected active state');
  }
  assertEquals(prepared.state.priorSearchUseCount, 1);
  assertEquals(prepared.state.requestSearchResultOwnership, ['owned']);
});

test('prepareAnthropicMessagesWebSearchShimRequest passes through foreign native-looking history that does not decode', () => {
  const payload: AnthropicMessagesPayload = {
    model: 'claude-test',
    max_tokens: 64,
    messages: [
      { role: 'user', content: 'latest React docs' },
      {
        role: 'assistant',
        content: [
          {
            caller: { type: 'direct' },
            type: 'server_tool_use',
            id: 'srvtoolu_foreign',
            name: 'web_search',
            input: { query: 'latest React docs' },
          },
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_foreign',
            content: [
              {
                type: 'web_search_result',
                url: 'https://react.dev',
                title: 'React',
                encrypted_content: 'foreign.payload',
              },
            ],
          },
        ],
      },
    ],
  };

  const prepared = prepareAnthropicMessagesWebSearchShimRequest(payload);

  assertEquals(prepared.type, 'ok');
  if (prepared.type !== 'ok') throw new Error('expected ok result');

  assertEquals(prepared.state.mode === 'inactive', true);
  assertEquals(prepared.payload, payload);
});

test('generation and count_tokens prepare identical web-search request payloads', async () => {
  const source = makeNativeReplayPayload();
  const seen: AnthropicMessagesPayload[] = [];
  const fixture = messagesFixture([messagesUpstream({
    flags: ['anthropic-messages-web-search-shim'],
    fetcher: async (url, init) => {
      seen.push(requestPayload(init));
      return new URL(url).pathname.endsWith('/count_tokens') ? new Response(null, { status: 204 }) : generateReply();
    },
  })], { webSearchProvider: webSearchProvider(fakeProviderOk) });
  const generate = await fixture.send(source);
  const count = await fixture.send(source, { count: true });
  expect(await generate.done).toMatchObject({ ok: true });
  expect(await count.done).toMatchObject({ ok: true });
  assertEquals(count.response.status, 204);
  assertEquals(seen[0], { ...seen[1], stream: true });
  const rewrittenTool = seen[0]?.tools?.[0] as AnthropicMessagesClientTool;
  assertEquals(rewrittenTool.name, 'web_search');
  assertEquals('type' in rewrittenTool, false);
});

test('count_tokens returns a native error response for invalid web-search tools', async () => {
  const fixture = messagesFixture([messagesUpstream({
    flags: ['anthropic-messages-web-search-shim'],
    fetcher: async () => { throw new Error('unexpected provider call'); },
  })]);
  const { facts, response, done } = await fixture.send({
    model: 'claude-test',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'search' }],
    tools: [{ name: 'web_search', type: 'web_search_20260209' }, { name: 'web_search', type: 'web_search_20260209' }],
  }, { count: true });

  assertEquals(response.status, 400);
  expect(await response.json()).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } });
  expect(await done).toMatchObject({ ok: true });
  expect(await facts['response.render'].promise).toEqual({ kind: 'completed' });
  expect(facts['response.http'].exchange).toBeUndefined();
  expect(fixture.usage).toEqual([]);
});

const runReplayOnlyShim = async (messageId: string): Promise<ProtocolFrame<AnthropicMessagesStreamEventEx>[]> => {
  const { tools: _tools, ...payload } = makeNativeReplayPayload();
  const fixture = messagesFixture([messagesUpstream({
    flags: ['anthropic-messages-web-search-shim'],
    fetcher: async () => generateReply(
      anthropicMessagesResponseToUpstreamFrames({
        container: null, diagnostics: null, stop_details: null,
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, output_tokens_details: null, server_tool_use: null, service_tier: null, input_tokens: 10, output_tokens: 1 },
        content: [
          {
            type: 'text',
            text: 'Use the docs.',
            citations: [
              {
                type: 'search_result_location',
                source: 'https://react.dev',
                title: 'React',
                search_result_index: 0,
                start_block_index: 0,
                end_block_index: 0,
                cited_text: 'Official React documentation',
              },
            ],
          },
        ],
      }),
    ),
  })]);
  const { response, done } = await fixture.send({ ...payload, stream: true });
  expect(response.status).toBe(200);
  const wire = await response.text();
  expect(await done).toMatchObject({ ok: true });
  return wire.split('\n').filter(line => line.startsWith('data: ')).map(line => eventFrame(JSON.parse(line.slice(6)) as AnthropicMessagesStreamEventEx));
};

test('webSearchShim returns an internal 500 when the request requires disabled search config', async () => {
  const fixture = messagesFixture([messagesUpstream({
    flags: ['anthropic-messages-web-search-shim'],
    fetcher: async () => { throw new Error('unexpected provider call'); },
  })]);
  const { facts, response, done } = await fixture.send({
    model: 'claude-test',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'latest React docs' }],
    tools: [{ name: 'web_search', type: 'web_search_20260209' }],
  });
  assertEquals(response.status, 500);
  expect(await response.json()).toMatchObject({ type: 'error', error: { type: 'internal_error', message: expect.stringContaining('requires an enabled search provider') } });
  expect(await done).toMatchObject({ ok: true });
  expect(await facts['response.render'].promise).toEqual({ kind: 'completed' });
  expect(facts['response.http'].exchange).toBeUndefined();
  expect(fixture.usage).toEqual([]);
});

test('webSearchShim emits native-like citation deltas for replay-only history', async () => {
  const collected = await runReplayOnlyShim('msg_replay_only_stream');

  const frames = collected.map(anthropicMessagesProtocolFrameToSSEFrame).filter(frame => frame !== null);
  const citationFrame = frames.find(frame => {
    if (frame.type !== 'sse' || frame.event !== 'content_block_delta') {
      return false;
    }

    return (JSON.parse(frame.data) as { delta?: { type?: string } }).delta?.type === 'citations_delta';
  });

  assertExists(citationFrame);
  const citation = (
    JSON.parse(citationFrame.data) as {
      delta: {
        citation: {
          type: string;
          url: string;
          title: string;
          encrypted_index: string;
        };
      };
    }
  ).delta.citation;

  assertEquals(citation.type, 'web_search_result_location');
  assertEquals(citation.url, 'https://react.dev');
  assertEquals(citation.title, 'React');
  assertEquals(decodeWebSearchCitationPayload(citation.encrypted_index), {
    search_result_index: 0,
    start_block_index: 0,
    end_block_index: 0,
  });
});

const upstreamMessageStart = (id = 'msg_upstream'): AnthropicMessagesStreamEventEx => ({
  type: 'message_start',
  message: {
    container: null, diagnostics: null, stop_details: null,
    id,
    type: 'message',
    role: 'assistant',
    content: [],
    model: 'claude-test',
    stop_reason: null,
    stop_sequence: null,
    usage: { cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, output_tokens_details: null, server_tool_use: null, service_tier: null, input_tokens: 10, output_tokens: 0 },
  },
});

const upstreamTextBlock = (index: number, text: string, citations?: AnthropicMessagesStreamEventEx[]): AnthropicMessagesStreamEventEx[] => [
  {
    type: 'content_block_start',
    index,
    content_block: { citations: null, type: 'text', text: '' },
  },
  ...(text.length > 0
    ? [{
        type: 'content_block_delta' as const,
        index,
        delta: { type: 'text_delta' as const, text },
      }]
    : []),
  ...(citations ?? []),
  { type: 'content_block_stop', index },
];

const upstreamWebSearchBlock = (index: number, id: string, query: string): AnthropicMessagesStreamEventEx[] => [
  {
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', id, name: 'web_search', input: {} },
  },
  {
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query }) },
  },
  { type: 'content_block_stop', index },
];

const upstreamWebSearchBlockRawJson = (index: number, id: string, rawJson: string): AnthropicMessagesStreamEventEx[] => [
  {
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', id, name: 'web_search', input: {} },
  },
  ...(rawJson.length > 0
    ? [{
        type: 'content_block_delta' as const,
        index,
        delta: { type: 'input_json_delta' as const, partial_json: rawJson },
      }]
    : []),
  { type: 'content_block_stop', index },
];

const upstreamClientToolBlock = (index: number, id: string, name: string, input: Record<string, unknown>): AnthropicMessagesStreamEventEx[] => [
  {
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', id, name, input: {} },
  },
  {
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
  },
  { type: 'content_block_stop', index },
];

const upstreamMessageEnd = (stopReason: NonNullable<AnthropicMessagesResult['stop_reason']> = 'tool_use'): AnthropicMessagesStreamEventEx[] => [
  {
    type: 'message_delta',
    delta: { container: null, stop_details: null, stop_reason: stopReason, stop_sequence: null },
    usage: { input_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null, server_tool_use: null, output_tokens: 7 },
  },
  { type: 'message_stop' },
];

const collectStreamEvents = async (
  frames: AsyncIterable<ProviderFrame<AnthropicMessagesStreamEventEx>>,
): Promise<AnthropicMessagesStreamEventEx[]> => {
  const events: AnthropicMessagesStreamEventEx[] = [];
  for await (const frame of frames) {
    if (frame.type === 'event') events.push(frame.event);
  }
  return events;
};

const runStreamingShim = (
  events: AnthropicMessagesStreamEventEx[],
  state: AnthropicMessagesWebSearchShimState,
  provider?: ReturnType<typeof activeProvider>,
) =>
  collectStreamEvents(
    rewriteAnthropicMessagesWebSearchEventsToNative(
      toAsyncIterable(events.map(event => ({ type: 'event' as const, event }))),
      state,
      provider,
    ),
  );

test('preserves the transport failure when a web-search block is interrupted', async () => {
  const failure: TransportFailure = { type: 'transport-error', error: { name: 'Error', message: 'connection ended during search' } };
  const start = eventFrame(upstreamMessageStart());
  const events = [
    start,
    ...upstreamWebSearchBlockRawJson(0, 'toolu_search', '{"query":"react docs"}').slice(0, -1).map(eventFrame),
    failure,
  ];
  const search = vi.fn(activeProvider(fakeProviderOk));
  const output = await Array.fromAsync(rewriteAnthropicMessagesWebSearchEventsToNative(
    toAsyncIterable(events), activeAnthropicMessagesWebSearchShimState(), search,
  ));
  expect(output).toEqual([start, failure]);
  expect(output.at(-1)).toBe(failure);
  expect(search).not.toHaveBeenCalled();
});

test.each(['success', 'search failure', 'recording failure'] as const)('webSearchShim settles each tool sub-run after %s', async outcome => {
  const search = outcome === 'search failure' ? searchOnlyProvider(async () => { throw new Error('test search failure'); }) : fakeProviderOk;
  const writeError = new Error('test search usage write failure');
  const recordSearchUsage = vi.fn<GatewayServices['searchUsageStore']['record']>(async () => {
    if (outcome === 'recording failure') throw writeError;
  });
  const upstreamEvents = [
    upstreamMessageStart(),
    ...upstreamWebSearchBlock(0, 'toolu_search', 'react docs'),
    ...upstreamMessageEnd(),
  ];
  const fixture = messagesFixture([messagesUpstream({
    flags: ['anthropic-messages-web-search-shim'],
    fetcher: async () => generateReply(upstreamEvents.map(eventFrame)),
  })], { webSearchProvider: webSearchProvider(search), recordSearchUsage });

  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const { response, done } = await fixture.send({
      model: 'test-model', max_tokens: 32, messages: [{ role: 'user', content: 'search' }],
      tools: [{ name: 'web_search', type: 'web_search_20260209' }],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      content: expect.arrayContaining([
        expect.objectContaining({ type: 'server_tool_use' }),
        expect.objectContaining({
          type: 'web_search_tool_result',
          content: outcome === 'search failure'
            ? { type: 'web_search_tool_result_error', error_code: 'unavailable' }
            : expect.arrayContaining([expect.objectContaining({ type: 'web_search_result', url: 'https://react.dev' })]),
        }),
      ]),
      stop_reason: 'pause_turn',
      usage: { server_tool_use: { web_search_requests: 1 } },
    });
    expect(await done).toMatchObject({ ok: true });
    expect(fixture.events.filter(event => event.k === 'enter' && event.edge === 'subrun' && event.pipeline === 'webSearch')).toHaveLength(1);
    expect(recordSearchUsage).toHaveBeenCalledOnce();
    expect(recordSearchUsage).toHaveBeenCalledWith(expect.objectContaining({ provider: 'tavily', keyId: 'test-key', action: 'search', requests: 1 }));
    expect(fixture.usage).toHaveLength(1);
    if (outcome === 'recording failure') {
      expect(errorLog).toHaveBeenCalledWith('Web search usage record error:', writeError);
      expect(fixture.events).toContainEqual(expect.objectContaining({
        k: 'settled', ok: true, value: expect.objectContaining({ persisted: false, errors: [expect.objectContaining({ message: writeError.message })] }),
      }));
    }
  } finally {
    errorLog.mockRestore();
  }
});

test('rewriteAnthropicMessagesWebSearchEventsToNative single web search emits server_tool_use/result pair around text', async () => {
  const events = await runStreamingShim(
    [
      upstreamMessageStart(),
      ...upstreamTextBlock(0, 'Searching...'),
      ...upstreamWebSearchBlock(1, 'toolu_1', 'react 19'),
      ...upstreamTextBlock(2, 'Done.'),
      ...upstreamMessageEnd('tool_use'),
    ],
    activeAnthropicMessagesWebSearchShimState(),
    activeProvider(fakeProviderOk),
  );

  assertEquals(
    events.map(event => event.type),
    [
      'message_start',
      'content_block_start', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_stop',
      'content_block_start', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_stop',
      'message_delta', 'message_stop',
    ],
  );

  const indexed = events.filter(event => event.type === 'content_block_start' || event.type === 'content_block_stop' || event.type === 'content_block_delta');
  assertEquals(indexed.map(event => (event as { index: number }).index), [0, 0, 0, 1, 1, 2, 2, 3, 3, 3]);

  const serverToolUse = events.find(event => event.type === 'content_block_start' && event.content_block.type === 'server_tool_use');
  assertEquals(serverToolUse?.type === 'content_block_start' ? serverToolUse.content_block : undefined, {
    caller: { type: 'direct' },
    type: 'server_tool_use',
    id: 'srvtoolu_1',
    name: 'web_search',
    input: { query: 'react 19' },
  });

  const toolResult = events.find(event => event.type === 'content_block_start' && event.content_block.type === 'web_search_tool_result');
  assertExists(toolResult);

  const messageDelta = events.find(event => event.type === 'message_delta');
  assertEquals(messageDelta?.type === 'message_delta' ? messageDelta.delta.stop_reason : undefined, 'pause_turn');
  assertEquals(messageDelta?.type === 'message_delta' ? messageDelta.usage?.server_tool_use : undefined, { web_search_requests: 1, web_fetch_requests: 0 });
});

test('rewriteAnthropicMessagesWebSearchEventsToNative synthesizes usage omitted by vLLM streams', async () => {
  const messageEndWithoutUsage = {
    type: 'message_delta',
    delta: { container: null, stop_details: null, stop_reason: 'tool_use', stop_sequence: null },
  } as unknown as AnthropicMessagesStreamEventEx;
  const events = await runStreamingShim(
    [upstreamMessageStart(), ...upstreamWebSearchBlock(0, 'toolu_1', 'react 19'), messageEndWithoutUsage, { type: 'message_stop' }],
    activeAnthropicMessagesWebSearchShimState(),
    activeProvider(fakeProviderOk),
  );
  const messageDelta = events.find(event => event.type === 'message_delta');
  assertEquals(messageDelta?.type === 'message_delta' ? messageDelta.usage : undefined, {
    input_tokens: null,
    output_tokens: 0,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    output_tokens_details: null,
    server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 },
  });
});

test('rewriteAnthropicMessagesWebSearchEventsToNative surfaces unavailable on the second search', async () => {
  let providerCalls = 0;
  const events = await runStreamingShim(
    [
      upstreamMessageStart(),
      ...upstreamWebSearchBlock(0, 'toolu_1', 'first'),
      ...upstreamWebSearchBlock(1, 'toolu_2', 'second'),
      ...upstreamMessageEnd('tool_use'),
    ],
    activeAnthropicMessagesWebSearchShimState({ priorSearchUseCount: 0 }),
    activeProvider(searchOnlyProvider(() => {
      providerCalls += 1;
      if (providerCalls === 2) return Promise.resolve({ type: 'error', errorCode: 'unavailable' });
      return Promise.resolve({ type: 'ok', results: [] });
    })),
  );

  const resultBlocks = events.filter(event => event.type === 'content_block_start' && event.content_block.type === 'web_search_tool_result') as Array<Extract<AnthropicMessagesStreamEventEx, { type: 'content_block_start' }>>;
  assertEquals(resultBlocks.length, 2);
  const secondResult = resultBlocks[1].content_block as { content: unknown };
  assertEquals(secondResult.content, { type: 'web_search_tool_result_error', error_code: 'unavailable' });

  const messageDelta = events.find(event => event.type === 'message_delta');
  assertEquals(messageDelta?.type === 'message_delta' ? messageDelta.usage?.server_tool_use : undefined, { web_search_requests: 2, web_fetch_requests: 0 });
});

test('rewriteAnthropicMessagesWebSearchEventsToNative emits max_uses_exceeded once limit is hit', async () => {
  let providerCalls = 0;
  const events = await runStreamingShim(
    [
      upstreamMessageStart(),
      ...upstreamWebSearchBlock(0, 'toolu_1', 'first'),
      ...upstreamWebSearchBlock(1, 'toolu_2', 'second'),
      ...upstreamMessageEnd('tool_use'),
    ],
    activeAnthropicMessagesWebSearchShimState({ maxUses: 1 }),
    activeProvider(searchOnlyProvider(() => {
      providerCalls += 1;
      return Promise.resolve({ type: 'ok', results: [] });
    })),
  );

  assertEquals(providerCalls, 1);
  const resultBlocks = events.filter(event => event.type === 'content_block_start' && event.content_block.type === 'web_search_tool_result') as Array<Extract<AnthropicMessagesStreamEventEx, { type: 'content_block_start' }>>;
  assertEquals(resultBlocks.length, 2);
  assertEquals((resultBlocks[1].content_block as { content: unknown }).content, { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' });

  const messageDelta = events.find(event => event.type === 'message_delta');
  assertEquals(messageDelta?.type === 'message_delta' ? messageDelta.usage?.server_tool_use : undefined, { web_search_requests: 1, web_fetch_requests: 0 });
});

test('rewriteAnthropicMessagesWebSearchEventsToNative keeps client tool_use and reports tool_use stop_reason in mixed turn', async () => {
  const events = await runStreamingShim(
    [
      upstreamMessageStart(),
      ...upstreamWebSearchBlock(0, 'toolu_1', 'react 19'),
      ...upstreamClientToolBlock(1, 'toolu_calc', 'calculator', { expression: '2+2' }),
      ...upstreamMessageEnd('tool_use'),
    ],
    activeAnthropicMessagesWebSearchShimState(),
    activeProvider(fakeProviderOk),
  );

  const blockStarts = events.filter(event => event.type === 'content_block_start') as Array<Extract<AnthropicMessagesStreamEventEx, { type: 'content_block_start' }>>;
  assertEquals(blockStarts.map(event => event.content_block.type), ['server_tool_use', 'web_search_tool_result', 'tool_use']);
  assertEquals(blockStarts.map(event => event.index), [0, 1, 2]);

  const messageDelta = events.find(event => event.type === 'message_delta');
  assertEquals(messageDelta?.type === 'message_delta' ? messageDelta.delta.stop_reason : undefined, 'tool_use');
});

test('rewriteAnthropicMessagesWebSearchEventsToNative leaves foreign citations untouched', async () => {
  const events = await runStreamingShim(
    [
      upstreamMessageStart(),
      {
        type: 'content_block_start',
        index: 0,
        content_block: { citations: null, type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'citations_delta',
          citation: {
            cited_text: '',
            type: 'search_result_location',
            source: 'https://example.com',
            title: 'Foreign',
            search_result_index: 0,
            start_block_index: 0,
            end_block_index: 0,
          },
        },
      },
      { type: 'content_block_stop', index: 0 },
      ...upstreamMessageEnd('end_turn'),
    ],
    {
      mode: 'replay_only',
      priorSearchUseCount: 0,
      requestSearchResultOwnership: ['foreign'],
    },
  );

  const citationsDelta = events.find(event => event.type === 'content_block_delta' && event.delta.type === 'citations_delta') as Extract<AnthropicMessagesStreamEventEx, { type: 'content_block_delta' }> | undefined;
  assertEquals(citationsDelta?.delta.type === 'citations_delta' ? citationsDelta.delta.citation.type : undefined, 'search_result_location');
});

test('rewriteAnthropicMessagesWebSearchEventsToNative delays later content until an intercepted search result is complete', async () => {
  const events = await runStreamingShim(
    [
      upstreamMessageStart(),
      ...upstreamWebSearchBlockRawJson(0, 'toolu_1', '{"query":"react 19"}').slice(0, -1),
      { type: 'content_block_start', index: 1, content_block: { citations: null, type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_stop', index: 0 },
      ...upstreamMessageEnd('tool_use'),
    ],
    activeAnthropicMessagesWebSearchShimState(),
    activeProvider(fakeProviderOk),
  );
  const blocks = events.filter(event => event.type === 'content_block_start' || event.type === 'content_block_delta' || event.type === 'content_block_stop');
  assertEquals(blocks.map(event => [event.type, event.index]), [
    ['content_block_start', 0],
    ['content_block_stop', 0],
    ['content_block_start', 1],
    ['content_block_stop', 1],
    ['content_block_start', 2],
    ['content_block_delta', 2],
    ['content_block_stop', 2],
  ]);
});
