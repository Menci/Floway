import { test } from 'vitest';

import type { MessagesInvocation } from './types.ts';
import {
  decodeWebSearchCitationPayload,
  decodeWebSearchResultPayload,
  encodeWebSearchCitationPayload,
  encodeWebSearchResultPayload,
  type MessagesWebSearchShimState,
  prepareMessagesWebSearchShimRequest,
  rewriteMessagesWebSearchEventsToNative,
  withMessagesWebSearchShim,
} from './web-search-shim.ts';
import { initRepo } from '../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { DEFAULT_SEARCH_CONFIG } from '../../../tools/web-search/search-config.ts';
import type { WebSearchProvider, WebSearchProviderResult } from '../../../tools/web-search/types.ts';
import { createNonResponsesSourceStore } from '../../responses/items/store.ts';
import type { ChatGatewayCtx } from '../../shared/gateway-ctx.ts';
import { type ProtocolFrame, eventFrame } from '@floway-dev/protocols/common';
import { messagesProtocolFrameToSSEFrame } from '@floway-dev/protocols/messages';
import type {
  MessagesAssistantContentBlock,
  MessagesClientTool,
  MessagesPayload,
  MessagesResult,
  MessagesStreamEvent,
  MessagesTextBlock,
  MessagesToolResultBlock,
  MessagesToolResultContentBlock,
  MessagesUserContentBlock,
} from '@floway-dev/protocols/messages';
import { assertEquals, assertExists, assertRejects, stubModelCandidate } from '@floway-dev/test-utils';

const testTelemetryModelIdentity = {
  model: 'test-model',
  upstream: 'test-upstream',
  modelKey: 'test-model-key',
  cost: null,
};

const invocation = (payload: MessagesPayload): MessagesInvocation => ({
  payload,
  candidate: stubModelCandidate({
    model: { endpoints: { messages: {} } },
    enabledFlags: new Set(['messages-web-search-shim']),
  }),
  targetApi: 'messages',
  headers: new Headers(),
});

const gatewayCtx = (apiKeyId: string = 'test-key'): ChatGatewayCtx => ({
  apiKeyId,
  upstreamIds: null,
  wantsStream: false,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
  backgroundScheduler: () => {},
  requestStartedAt: 0,
  store: createNonResponsesSourceStore(apiKeyId),
});

const encodeUnsignedPayload = (payload: unknown): string => btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

const makeNativeReplayPayload = (): MessagesPayload => ({
  model: 'claude-test',
  max_tokens: 64,
  tools: [{ type: 'web_search_20260209', max_uses: 2 }],
  messages: [
    { role: 'user', content: 'latest React docs' },
    {
      role: 'assistant',
      content: [
        {
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

const activeMessagesWebSearchShimState = (overrides: Partial<Extract<MessagesWebSearchShimState, { mode: 'active' }>> = {}): Extract<MessagesWebSearchShimState, { mode: 'active' }> => ({
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

const activeProvider = (impl: WebSearchProvider, apiKeyId: string = 'test-key') => ({
  providerName: 'tavily' as const,
  impl,
  apiKeyId,
});

const fakeProviderError =
  (errorCode: Extract<WebSearchProviderResult, { type: 'error' }>['errorCode']): WebSearchProvider =>
    searchOnlyProvider(() => Promise.resolve({ type: 'error', errorCode }));

const toAsyncIterable = async function* <T>(values: Iterable<T>): AsyncGenerator<T> {
  for (const value of values) {
    yield value;
  }
};

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];

  for await (const event of events) {
    collected.push(event);
  }

  return collected;
};

const messagesResponseToUpstreamFrames = (response: MessagesResult): ProtocolFrame<MessagesStreamEvent>[] => {
  const frames: ProtocolFrame<MessagesStreamEvent>[] = [
    eventFrame({
      type: 'message_start',
      message: {
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
      throw new Error(`messagesResponseToUpstreamFrames only handles text blocks; got ${block.type}`);
    }
    frames.push(eventFrame({
      type: 'content_block_start',
      index,
      content_block: {
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
      delta: { stop_reason: response.stop_reason, stop_sequence: response.stop_sequence },
      usage: { output_tokens: response.usage.output_tokens },
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

  const encodedExtraCitation = encodeUnsignedPayload({
    search_result_index: 0,
    start_block_index: 0,
    end_block_index: 0,
    extra: true,
  });
  assertEquals(decodeWebSearchCitationPayload(encodedExtraCitation), null);

  assertEquals(
    decodeWebSearchCitationPayload(
      encodeUnsignedPayload({
        search_result_index: -1,
        start_block_index: 0,
        end_block_index: 0,
      }),
    ),
    null,
  );

  assertEquals(
    decodeWebSearchCitationPayload(
      encodeUnsignedPayload({
        search_result_index: 0,
        start_block_index: -1,
        end_block_index: 0,
      }),
    ),
    null,
  );

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

test('prepareMessagesWebSearchShimRequest rewrites both native tool versions to client tools without renaming web_search', () => {
  for (const type of ['web_search_20250305', 'web_search_20260209'] as const) {
    const prepared = prepareMessagesWebSearchShimRequest({
      model: 'claude-test',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'latest React docs' }],
      tools: [{ type, name: 'web_search', max_uses: 2 }],
      tool_choice: { type: 'tool', name: 'web_search' },
    });

    assertEquals(prepared.type, 'ok');
    if (prepared.type !== 'ok') throw new Error('expected ok result');
    const rewrittenTool = prepared.payload.tools?.[0] as MessagesClientTool;
    assertEquals(rewrittenTool.name, 'web_search');
    assertEquals(rewrittenTool.description, 'The web_search tool searches the internet and returns up-to-date information from web sources.');
    assertEquals(rewrittenTool.input_schema, {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query',
        },
      },
      required: ['query'],
    });
    assertEquals(prepared.payload.tool_choice, {
      type: 'tool',
      name: 'web_search',
    });
    assertEquals(prepared.state.mode, 'active');
    if (prepared.state.mode !== 'active') {
      throw new Error('expected active state');
    }
    assertEquals(prepared.state.toolVersion, type);
  }
});

test('prepareMessagesWebSearchShimRequest rejects duplicate native tools', () => {
  const prepared = prepareMessagesWebSearchShimRequest({
    model: 'claude-test',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'latest React docs' }],
    tools: [{ type: 'web_search_20250305' }, { type: 'web_search_20260209' }],
  });

  assertEquals(prepared, {
    type: 'invalid-request',
    message: 'Only one native web search tool definition is supported per request.',
  });
});

test('prepareMessagesWebSearchShimRequest rejects native web search tools whose name is not web_search', () => {
  for (const type of ['web_search_20250305', 'web_search_20260209'] as const) {
    const prepared = prepareMessagesWebSearchShimRequest({
      model: 'claude-test',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'latest React docs' }],
      tools: [{ type, name: 'WebSearch' }],
    });

    assertEquals(prepared, {
      type: 'invalid-request',
      message: `tools.0.${type}.name: Input should be 'web_search'`,
    });
  }
});

test('prepareMessagesWebSearchShimRequest rejects native web search name collisions with client tools', () => {
  const prepared = prepareMessagesWebSearchShimRequest({
    model: 'claude-test',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'latest React docs' }],
    tools: [
      { type: 'web_search_20260209', name: 'web_search' },
      {
        name: 'web_search',
        description: 'user-defined tool',
        input_schema: { type: 'object' },
      },
    ],
  });

  assertEquals(prepared, {
    type: 'invalid-request',
    message: 'Native web search tool name collides with another client tool: web_search.',
  });
});

test('prepareMessagesWebSearchShimRequest passes in-array role:"system" messages through unchanged', () => {
  // Regression: prepareMessagesWebSearchReplay used to assume any non-user
  // message with array content was an assistant turn and rewrite it with
  // role: 'assistant'. After MessagesMessage was widened to include
  // MessagesSystemMessage, a system message with MessagesTextBlock[] content
  // would silently be re-roled. Verify the shim now passes system messages
  // through as-is whether their content is a string or text-block array.
  const payload: MessagesPayload = {
    model: 'claude-test',
    max_tokens: 64,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'be terse' },
      {
        role: 'system',
        content: [
          { type: 'text', text: 'paragraph A' },
          { type: 'text', text: 'paragraph B' },
        ],
      },
      { role: 'user', content: 'who are you' },
    ],
  };

  const prepared = prepareMessagesWebSearchShimRequest(payload);

  assertEquals(prepared.type, 'ok');
  if (prepared.type !== 'ok') throw new Error('expected ok result');

  const messages = prepared.payload.messages;
  assertEquals(messages.length, 4);
  assertEquals(messages[1], { role: 'system', content: 'be terse' });
  assertEquals(messages[2], {
    role: 'system',
    content: [
      { type: 'text', text: 'paragraph A' },
      { type: 'text', text: 'paragraph B' },
    ],
  });
});

test('prepareMessagesWebSearchShimRequest decodes our native-looking replay into upstream tool history', () => {
  const prepared = prepareMessagesWebSearchShimRequest(makeNativeReplayPayload());

  assertEquals(prepared.type, 'ok');
  if (prepared.type !== 'ok') throw new Error('expected ok result');

  const assistant = prepared.payload.messages[1];
  const user = prepared.payload.messages[2];

  assertEquals((assistant.content as MessagesAssistantContentBlock[])[0].type, 'tool_use');
  assertEquals(((assistant.content as MessagesAssistantContentBlock[])[1] as MessagesTextBlock).citations?.[0]?.type, 'search_result_location');
  assertEquals((((user.content as MessagesUserContentBlock[])[0] as MessagesToolResultBlock).content as MessagesToolResultContentBlock[])[0].type, 'search_result');
  assertEquals((user.content as MessagesUserContentBlock[]).length, 2);
  assertEquals(prepared.state.mode, 'active');
  if (prepared.state.mode !== 'active') {
    throw new Error('expected active state');
  }
  assertEquals(prepared.state.priorSearchUseCount, 1);
  assertEquals(prepared.state.requestSearchResultOwnership, ['owned']);
});

test('prepareMessagesWebSearchShimRequest leaves native-looking replay errors untouched', () => {
  const payload: MessagesPayload = {
    model: 'claude-test',
    max_tokens: 64,
    messages: [
      { role: 'user', content: 'latest React docs' },
      {
        role: 'assistant',
        content: [
          {
            type: 'server_tool_use',
            id: 'srvtoolu_1',
            name: 'web_search',
            input: { query: 'latest React docs' },
          },
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_1',
            content: {
              type: 'web_search_tool_result_error',
              error_code: 'too_many_requests',
            },
          },
        ],
      },
    ],
  };

  const prepared = prepareMessagesWebSearchShimRequest(payload);

  assertEquals(prepared.type, 'ok');
  if (prepared.type !== 'ok') throw new Error('expected ok result');

  assertEquals(prepared.state.mode === 'inactive', true);
  assertEquals(prepared.payload, payload);
});

test('prepareMessagesWebSearchShimRequest passes through foreign native-looking history that does not decode', () => {
  const payload: MessagesPayload = {
    model: 'claude-test',
    max_tokens: 64,
    messages: [
      { role: 'user', content: 'latest React docs' },
      {
        role: 'assistant',
        content: [
          {
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

  const prepared = prepareMessagesWebSearchShimRequest(payload);

  assertEquals(prepared.type, 'ok');
  if (prepared.type !== 'ok') throw new Error('expected ok result');

  assertEquals(prepared.state.mode === 'inactive', true);
  assertEquals(prepared.payload, payload);
});

test('prepareMessagesWebSearchShimRequest creates a separate user tool_result message when the trailing user message is not a tool_result turn', () => {
  const payload: MessagesPayload = {
    model: 'claude-test',
    max_tokens: 64,
    messages: [
      { role: 'user', content: 'latest React docs' },
      {
        role: 'assistant',
        content: [
          {
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
                  content: [
                    {
                      type: 'text',
                      text: 'Official React documentation',
                    },
                  ],
                }),
              },
            ],
          },
        ],
      },
      { role: 'user', content: 'thanks' },
    ],
  };

  const prepared = prepareMessagesWebSearchShimRequest(payload);

  assertEquals(prepared.type, 'ok');
  if (prepared.type !== 'ok') throw new Error('expected ok result');

  assertEquals(prepared.payload.messages.length, 4);
  assertEquals(prepared.payload.messages[2].role, 'user');
  assertEquals(((prepared.payload.messages[2].content as MessagesUserContentBlock[])[0] as MessagesToolResultBlock).type, 'tool_result');
  assertEquals(prepared.payload.messages[3], {
    role: 'user',
    content: 'thanks',
  });
});

const initDisabledSearchRepo = async (): Promise<void> => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  await repo.searchConfig.save(DEFAULT_SEARCH_CONFIG);
};

const runReplayOnlyShim = async (messageId: string): Promise<ProtocolFrame<MessagesStreamEvent>[]> => {
  await initDisabledSearchRepo();

  const { tools: _tools, ...payload } = makeNativeReplayPayload();

  const result = await withMessagesWebSearchShim(invocation(payload), gatewayCtx(), () =>
    Promise.resolve({
      type: 'events',
      events: toAsyncIterable(
        messagesResponseToUpstreamFrames({
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
          content: [
            {
              type: 'text',
              text: 'Use the docs.',
              citations: [
                {
                  type: 'search_result_location',
                  url: 'https://react.dev',
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
      modelIdentity: testTelemetryModelIdentity,
    }));

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('expected events result');

  return await collect(result.events);
};

test('withMessagesWebSearchShim returns internal-error when request requires disabled search config', async () => {
  await initDisabledSearchRepo();

  const result = await withMessagesWebSearchShim(
    invocation({
      model: 'claude-test',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'latest React docs' }],
      tools: [{ type: 'web_search_20260209' }],
    }), gatewayCtx(),
    () => Promise.reject(new Error('run should not be called')),
  );

  assertEquals(result.type, 'internal-error');
});

test('withMessagesWebSearchShim allows replay-only history when the search provider is disabled', async () => {
  const collected = await runReplayOnlyShim('msg_replay_only');

  const events = collected.flatMap(frame => (frame.type === 'event' ? [frame.event] : []));
  const citationsDelta = events.find((event): event is Extract<MessagesStreamEvent, { type: 'content_block_delta' }> => event.type === 'content_block_delta' && event.delta.type === 'citations_delta');
  assertEquals(citationsDelta?.delta.type === 'citations_delta' ? citationsDelta.delta.citation.type : undefined, 'web_search_result_location');
});

test('withMessagesWebSearchShim emits native-like citation deltas for replay-only history', async () => {
  const collected = await runReplayOnlyShim('msg_replay_only_stream');

  const frames = collected.map(messagesProtocolFrameToSSEFrame).filter(frame => frame !== null);
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

const upstreamMessageStart = (id = 'msg_upstream'): MessagesStreamEvent => ({
  type: 'message_start',
  message: {
    id,
    type: 'message',
    role: 'assistant',
    content: [],
    model: 'claude-test',
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 0 },
  },
});

const upstreamTextBlock = (index: number, text: string, citations?: MessagesStreamEvent[]): MessagesStreamEvent[] => [
  {
    type: 'content_block_start',
    index,
    content_block: { type: 'text', text: '' },
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

const upstreamWebSearchBlock = (index: number, id: string, query: string): MessagesStreamEvent[] => [
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

const upstreamWebSearchBlockRawJson = (index: number, id: string, rawJson: string): MessagesStreamEvent[] => [
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

const upstreamClientToolBlock = (index: number, id: string, name: string, input: Record<string, unknown>): MessagesStreamEvent[] => [
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

const upstreamMessageEnd = (stopReason: NonNullable<MessagesResult['stop_reason']> = 'tool_use'): MessagesStreamEvent[] => [
  {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 7 },
  },
  { type: 'message_stop' },
];

const collectStreamEvents = async (
  frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>,
): Promise<MessagesStreamEvent[]> => {
  const events: MessagesStreamEvent[] = [];
  for await (const frame of frames) {
    if (frame.type === 'event') events.push(frame.event);
  }
  return events;
};

const runStreamingShim = (
  events: MessagesStreamEvent[],
  state: MessagesWebSearchShimState,
  provider?: ReturnType<typeof activeProvider>,
) =>
  collectStreamEvents(
    rewriteMessagesWebSearchEventsToNative(
      toAsyncIterable(events.map(event => ({ type: 'event' as const, event }))),
      state,
      provider,
    ),
  );

test('rewriteMessagesWebSearchEventsToNative single web search emits server_tool_use/result pair around text', async () => {
  const events = await runStreamingShim(
    [
      upstreamMessageStart(),
      ...upstreamTextBlock(0, 'Searching...'),
      ...upstreamWebSearchBlock(1, 'toolu_1', 'react 19'),
      ...upstreamTextBlock(2, 'Done.'),
      ...upstreamMessageEnd('tool_use'),
    ],
    activeMessagesWebSearchShimState(),
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
    type: 'server_tool_use',
    id: 'srvtoolu_1',
    name: 'web_search',
    input: { query: 'react 19' },
  });

  const toolResult = events.find(event => event.type === 'content_block_start' && event.content_block.type === 'web_search_tool_result');
  assertExists(toolResult);

  const messageDelta = events.find(event => event.type === 'message_delta');
  assertEquals(messageDelta?.type === 'message_delta' ? messageDelta.delta.stop_reason : undefined, 'pause_turn');
  assertEquals(messageDelta?.type === 'message_delta' ? messageDelta.usage?.server_tool_use : undefined, { web_search_requests: 1 });
});

test('rewriteMessagesWebSearchEventsToNative renumbers indices across two intercepted searches', async () => {
  let providerCalls = 0;
  const events = await runStreamingShim(
    [
      upstreamMessageStart(),
      ...upstreamTextBlock(0, 'Looking up first.'),
      ...upstreamWebSearchBlock(1, 'toolu_1', 'react 19 release notes'),
      ...upstreamTextBlock(2, 'And another.'),
      ...upstreamWebSearchBlock(3, 'toolu_2', 'react 19 features'),
      ...upstreamTextBlock(4, 'Summary.'),
      ...upstreamMessageEnd('tool_use'),
    ],
    activeMessagesWebSearchShimState(),
    activeProvider(searchOnlyProvider(() => {
      providerCalls += 1;
      return Promise.resolve({ type: 'ok', results: [] });
    })),
  );

  const blockIndexEvents = events.filter(event => event.type === 'content_block_start') as Array<Extract<MessagesStreamEvent, { type: 'content_block_start' }>>;
  assertEquals(blockIndexEvents.map(event => event.index), [0, 1, 2, 3, 4, 5, 6]);
  assertEquals(blockIndexEvents.map(event => event.content_block.type), [
    'text',
    'server_tool_use',
    'web_search_tool_result',
    'text',
    'server_tool_use',
    'web_search_tool_result',
    'text',
  ]);

  assertEquals(providerCalls, 2);
  const messageDelta = events.find(event => event.type === 'message_delta');
  assertEquals(messageDelta?.type === 'message_delta' ? messageDelta.usage?.server_tool_use : undefined, { web_search_requests: 2 });
});

test('rewriteMessagesWebSearchEventsToNative surfaces unavailable when provider throws on second search', async () => {
  let providerCalls = 0;
  const events = await runStreamingShim(
    [
      upstreamMessageStart(),
      ...upstreamWebSearchBlock(0, 'toolu_1', 'first'),
      ...upstreamWebSearchBlock(1, 'toolu_2', 'second'),
      ...upstreamMessageEnd('tool_use'),
    ],
    activeMessagesWebSearchShimState({ priorSearchUseCount: 0 }),
    activeProvider(searchOnlyProvider(() => {
      providerCalls += 1;
      if (providerCalls === 2) return Promise.reject(new Error('boom'));
      return Promise.resolve({ type: 'ok', results: [] });
    })),
  );

  const resultBlocks = events.filter(event => event.type === 'content_block_start' && event.content_block.type === 'web_search_tool_result') as Array<Extract<MessagesStreamEvent, { type: 'content_block_start' }>>;
  assertEquals(resultBlocks.length, 2);
  const secondResult = resultBlocks[1].content_block as { content: unknown };
  assertEquals(secondResult.content, { type: 'web_search_tool_result_error', error_code: 'unavailable' });

  const messageDelta = events.find(event => event.type === 'message_delta');
  assertEquals(messageDelta?.type === 'message_delta' ? messageDelta.usage?.server_tool_use : undefined, { web_search_requests: 2 });
});

test('rewriteMessagesWebSearchEventsToNative maps provider error result codes through', async () => {
  const events = await runStreamingShim(
    [
      upstreamMessageStart(),
      ...upstreamWebSearchBlock(0, 'toolu_1', 'first'),
      ...upstreamMessageEnd('tool_use'),
    ],
    activeMessagesWebSearchShimState(),
    activeProvider(fakeProviderError('too_many_requests')),
  );

  const resultBlock = events.find(event => event.type === 'content_block_start' && event.content_block.type === 'web_search_tool_result') as Extract<MessagesStreamEvent, { type: 'content_block_start' }> | undefined;
  assertEquals((resultBlock?.content_block as { content: unknown }).content, { type: 'web_search_tool_result_error', error_code: 'too_many_requests' });
});

test('rewriteMessagesWebSearchEventsToNative emits max_uses_exceeded once limit is hit', async () => {
  let providerCalls = 0;
  const events = await runStreamingShim(
    [
      upstreamMessageStart(),
      ...upstreamWebSearchBlock(0, 'toolu_1', 'first'),
      ...upstreamWebSearchBlock(1, 'toolu_2', 'second'),
      ...upstreamMessageEnd('tool_use'),
    ],
    activeMessagesWebSearchShimState({ maxUses: 1 }),
    activeProvider(searchOnlyProvider(() => {
      providerCalls += 1;
      return Promise.resolve({ type: 'ok', results: [] });
    })),
  );

  assertEquals(providerCalls, 1);
  const resultBlocks = events.filter(event => event.type === 'content_block_start' && event.content_block.type === 'web_search_tool_result') as Array<Extract<MessagesStreamEvent, { type: 'content_block_start' }>>;
  assertEquals(resultBlocks.length, 2);
  assertEquals((resultBlocks[1].content_block as { content: unknown }).content, { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' });

  const messageDelta = events.find(event => event.type === 'message_delta');
  assertEquals(messageDelta?.type === 'message_delta' ? messageDelta.usage?.server_tool_use : undefined, { web_search_requests: 1 });
});

test('rewriteMessagesWebSearchEventsToNative honours priorSearchUseCount when computing remaining budget', async () => {
  let providerCalls = 0;
  await runStreamingShim(
    [
      upstreamMessageStart(),
      ...upstreamWebSearchBlock(0, 'toolu_1', 'first'),
      ...upstreamMessageEnd('tool_use'),
    ],
    activeMessagesWebSearchShimState({ priorSearchUseCount: 1, maxUses: 2 }),
    activeProvider(searchOnlyProvider(() => {
      providerCalls += 1;
      return Promise.resolve({ type: 'ok', results: [] });
    })),
  );

  assertEquals(providerCalls, 1);
});

test('rewriteMessagesWebSearchEventsToNative routes blank query to invalid_tool_input without provider call', async () => {
  let providerCalls = 0;
  const events = await runStreamingShim(
    [
      upstreamMessageStart(),
      ...upstreamWebSearchBlock(0, 'toolu_1', '   '),
      ...upstreamMessageEnd('tool_use'),
    ],
    activeMessagesWebSearchShimState(),
    activeProvider(searchOnlyProvider(() => {
      providerCalls += 1;
      return Promise.resolve({ type: 'ok', results: [] });
    })),
  );

  assertEquals(providerCalls, 0);
  const resultBlock = events.find(event => event.type === 'content_block_start' && event.content_block.type === 'web_search_tool_result') as Extract<MessagesStreamEvent, { type: 'content_block_start' }> | undefined;
  assertEquals((resultBlock?.content_block as { content: unknown }).content, { type: 'web_search_tool_result_error', error_code: 'invalid_tool_input' });
});

test('rewriteMessagesWebSearchEventsToNative routes oversized query to query_too_long', async () => {
  let providerCalls = 0;
  const events = await runStreamingShim(
    [
      upstreamMessageStart(),
      ...upstreamWebSearchBlock(0, 'toolu_1', 'x'.repeat(1001)),
      ...upstreamMessageEnd('tool_use'),
    ],
    activeMessagesWebSearchShimState(),
    activeProvider(searchOnlyProvider(() => {
      providerCalls += 1;
      return Promise.resolve({ type: 'ok', results: [] });
    })),
  );

  assertEquals(providerCalls, 0);
  const resultBlock = events.find(event => event.type === 'content_block_start' && event.content_block.type === 'web_search_tool_result') as Extract<MessagesStreamEvent, { type: 'content_block_start' }> | undefined;
  assertEquals((resultBlock?.content_block as { content: unknown }).content, { type: 'web_search_tool_result_error', error_code: 'query_too_long' });
});

test('rewriteMessagesWebSearchEventsToNative routes malformed input json to invalid_tool_input', async () => {
  let providerCalls = 0;
  const events = await runStreamingShim(
    [
      upstreamMessageStart(),
      ...upstreamWebSearchBlockRawJson(0, 'toolu_1', '{not json'),
      ...upstreamMessageEnd('tool_use'),
    ],
    activeMessagesWebSearchShimState(),
    activeProvider(searchOnlyProvider(() => {
      providerCalls += 1;
      return Promise.resolve({ type: 'ok', results: [] });
    })),
  );

  assertEquals(providerCalls, 0);
  const resultBlock = events.find(event => event.type === 'content_block_start' && event.content_block.type === 'web_search_tool_result') as Extract<MessagesStreamEvent, { type: 'content_block_start' }> | undefined;
  assertEquals((resultBlock?.content_block as { content: unknown }).content, { type: 'web_search_tool_result_error', error_code: 'invalid_tool_input' });
});

test('rewriteMessagesWebSearchEventsToNative keeps client tool_use and reports tool_use stop_reason in mixed turn', async () => {
  const events = await runStreamingShim(
    [
      upstreamMessageStart(),
      ...upstreamWebSearchBlock(0, 'toolu_1', 'react 19'),
      ...upstreamClientToolBlock(1, 'toolu_calc', 'calculator', { expression: '2+2' }),
      ...upstreamMessageEnd('tool_use'),
    ],
    activeMessagesWebSearchShimState(),
    activeProvider(fakeProviderOk),
  );

  const blockStarts = events.filter(event => event.type === 'content_block_start') as Array<Extract<MessagesStreamEvent, { type: 'content_block_start' }>>;
  assertEquals(blockStarts.map(event => event.content_block.type), ['server_tool_use', 'web_search_tool_result', 'tool_use']);
  assertEquals(blockStarts.map(event => event.index), [0, 1, 2]);

  const messageDelta = events.find(event => event.type === 'message_delta');
  assertEquals(messageDelta?.type === 'message_delta' ? messageDelta.delta.stop_reason : undefined, 'tool_use');
});

test('rewriteMessagesWebSearchEventsToNative rewrites citations carried by text_delta', async () => {
  const events = await runStreamingShim(
    [
      upstreamMessageStart(),
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: 'cited',
          citations: [
            {
              type: 'search_result_location',
              url: 'https://react.dev',
              title: 'React',
              search_result_index: 0,
              start_block_index: 0,
              end_block_index: 0,
            },
          ],
        },
      },
      { type: 'content_block_stop', index: 0 },
      ...upstreamMessageEnd('end_turn'),
    ],
    {
      mode: 'replay_only',
      priorSearchUseCount: 0,
      requestSearchResultOwnership: ['owned'],
    },
  );

  const textDelta = events.find(event => event.type === 'content_block_delta' && event.delta.type === 'text_delta') as Extract<MessagesStreamEvent, { type: 'content_block_delta' }> | undefined;
  assertEquals(textDelta?.delta.type === 'text_delta' ? textDelta.delta.citations?.[0]?.type : undefined, 'web_search_result_location');
});

test('rewriteMessagesWebSearchEventsToNative rewrites citations_delta entries', async () => {
  const events = await runStreamingShim(
    [
      upstreamMessageStart(),
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'citations_delta',
          citation: {
            type: 'search_result_location',
            url: 'https://react.dev',
            title: 'React',
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
      requestSearchResultOwnership: ['owned'],
    },
  );

  const citationsDelta = events.find(event => event.type === 'content_block_delta' && event.delta.type === 'citations_delta') as Extract<MessagesStreamEvent, { type: 'content_block_delta' }> | undefined;
  assertEquals(citationsDelta?.delta.type === 'citations_delta' ? citationsDelta.delta.citation.type : undefined, 'web_search_result_location');
});

test('rewriteMessagesWebSearchEventsToNative rewrites pre-populated citations on content_block_start', async () => {
  const events = await runStreamingShim(
    [
      upstreamMessageStart(),
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'text',
          text: '',
          citations: [
            {
              type: 'search_result_location',
              url: 'https://react.dev',
              title: 'React',
              search_result_index: 0,
              start_block_index: 0,
              end_block_index: 0,
            },
          ],
        },
      },
      { type: 'content_block_stop', index: 0 },
      ...upstreamMessageEnd('end_turn'),
    ],
    {
      mode: 'replay_only',
      priorSearchUseCount: 0,
      requestSearchResultOwnership: ['owned'],
    },
  );

  const blockStart = events.find(event => event.type === 'content_block_start') as Extract<MessagesStreamEvent, { type: 'content_block_start' }> | undefined;
  assertEquals(blockStart?.content_block.type === 'text' ? blockStart.content_block.citations?.[0]?.type : undefined, 'web_search_result_location');
});

test('rewriteMessagesWebSearchEventsToNative leaves foreign citations untouched', async () => {
  const events = await runStreamingShim(
    [
      upstreamMessageStart(),
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'citations_delta',
          citation: {
            type: 'search_result_location',
            url: 'https://example.com',
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

  const citationsDelta = events.find(event => event.type === 'content_block_delta' && event.delta.type === 'citations_delta') as Extract<MessagesStreamEvent, { type: 'content_block_delta' }> | undefined;
  assertEquals(citationsDelta?.delta.type === 'citations_delta' ? citationsDelta.delta.citation.type : undefined, 'search_result_location');
});

test('rewriteMessagesWebSearchEventsToNative replay-only mode forwards message_delta unchanged', async () => {
  const events = await runStreamingShim(
    [
      upstreamMessageStart(),
      ...upstreamTextBlock(0, 'plain text'),
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 5 },
      },
      { type: 'message_stop' },
    ],
    {
      mode: 'replay_only',
      priorSearchUseCount: 0,
      requestSearchResultOwnership: [],
    },
  );

  const messageDelta = events.find(event => event.type === 'message_delta');
  assertEquals(messageDelta?.type === 'message_delta' ? messageDelta.delta : undefined, { stop_reason: 'end_turn', stop_sequence: null });
  assertEquals(messageDelta?.type === 'message_delta' ? messageDelta.usage : undefined, { output_tokens: 5 });
});

test('rewriteMessagesWebSearchEventsToNative forwards upstream error and returns without synthetic terminal', async () => {
  const events = await runStreamingShim(
    [
      upstreamMessageStart(),
      {
        type: 'error',
        error: { type: 'overloaded_error', message: 'upstream overloaded' },
      },
    ],
    activeMessagesWebSearchShimState(),
    activeProvider(fakeProviderOk),
  );

  assertEquals(events.map(event => event.type), ['message_start', 'error']);
});

test('rewriteMessagesWebSearchEventsToNative yields message_stop even when message_delta is missing', async () => {
  const events = await runStreamingShim(
    [
      upstreamMessageStart(),
      ...upstreamTextBlock(0, 'just text'),
      { type: 'message_stop' },
    ],
    {
      mode: 'replay_only',
      priorSearchUseCount: 0,
      requestSearchResultOwnership: [],
    },
  );

  assertEquals(events[events.length - 1].type, 'message_stop');
});

test('rewriteMessagesWebSearchEventsToNative throws when upstream interleaves content blocks', async () => {
  await assertRejects(
    () =>
      runStreamingShim(
        [
          upstreamMessageStart(),
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          },
          {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'text', text: '' },
          },
        ],
        {
          mode: 'replay_only',
          priorSearchUseCount: 0,
          requestSearchResultOwnership: [],
        },
      ),
    Error,
    'interleaved content blocks',
  );
});

test('rewriteMessagesWebSearchEventsToNative requires a provider when mode is active', async () => {
  await assertRejects(
    () =>
      runStreamingShim(
        [upstreamMessageStart(), ...upstreamMessageEnd('end_turn')],
        activeMessagesWebSearchShimState(),
      ),
    Error,
    'Active messages web-search rewrite requires a provider.',
  );
});
