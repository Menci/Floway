import { test } from 'vitest';

import type {
  MessagesResult,
  MessagesSearchResultBlock,
  MessagesSearchResultLocationCitation,
  MessagesServerToolUseBlock,
  MessagesStreamEvent,
  MessagesTextBlock,
  MessagesTool,
  MessagesToolResultContentBlock,
  MessagesWebSearchResultBlock,
  MessagesWebSearchToolResultBlock,
} from './index.ts';
import { reassembleMessagesEvents } from './reassemble.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

function makeEvents<T = MessagesStreamEvent>(chunks: Array<{ event?: string; data: unknown }>): AsyncIterable<T> {
  return (async function* () {
    for (const chunk of chunks) {
      if (typeof chunk.data === 'string') continue;

      const data = chunk.data as Record<string, unknown>;
      yield (chunk.event && typeof data.type !== 'string' ? { ...data, type: chunk.event } : data) as T;
    }
  })();
}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

type _toolResultContentExcludesWebSearchResult = Expect<Equal<Extract<MessagesToolResultContentBlock, MessagesWebSearchResultBlock>, never>>;
type _serverToolUseNameIsString = Expect<Equal<MessagesServerToolUseBlock['name'], string>>;
type _serverToolUseInputIsQueryObject = Expect<Equal<MessagesServerToolUseBlock['input'], { query: string }>>;

test('reassembleMessagesEvents reassembles text response', async () => {
  const body = makeEvents([
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-test',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello ' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'world' },
      },
    },
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 0 },
    },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 5 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);

  const result: MessagesResult = await reassembleMessagesEvents(body);

  assertEquals(result.id, 'msg_1');
  assertEquals(result.model, 'claude-test');
  assertEquals(result.stop_reason, 'end_turn');
  assertEquals(result.content.length, 1);
  assertEquals(result.content[0].type, 'text');
  assertEquals((result.content[0] as { type: 'text'; text: string }).text, 'Hello world');
  assertEquals(result.usage.input_tokens, 10);
  assertEquals(result.usage.output_tokens, 5);
});

test('MessagesTool supports both client and native web search shapes', () => {
  const clientTool: MessagesTool = {
    name: 'get_weather',
    description: 'Fetches weather',
    input_schema: { type: 'object' },
    strict: true,
  };

  const nativeWebSearchTool: MessagesTool = {
    type: 'web_search_20250305',
    max_uses: 3,
    allowed_domains: ['example.com'],
    user_location: {
      type: 'approximate',
      city: 'San Francisco',
      region: 'CA',
      country: 'US',
      timezone: 'America/Los_Angeles',
    },
  };

  assertEquals('name' in clientTool, true);
  assertEquals(nativeWebSearchTool.type, 'web_search_20250305');
  if ('user_location' in nativeWebSearchTool) {
    assertEquals(nativeWebSearchTool.user_location?.type, 'approximate');
  }
});

test('Anthropic native web search shared shapes pass through reassembly unchanged', () => {
  const searchCitation: MessagesSearchResultLocationCitation = {
    type: 'search_result_location',
    url: 'https://docs.example.com/api-guide',
    title: 'API Guide',
    search_result_index: 0,
    start_block_index: 1,
    end_block_index: 2,
    cited_text: 'Error handling guidance',
  };

  const searchResult: MessagesSearchResultBlock = {
    type: 'search_result',
    source: 'https://docs.example.com/api-guide',
    title: 'API Guide',
    content: [{ type: 'text', text: 'Error handling guidance' }],
    citations: { enabled: true },
  };

  const serverToolUse: MessagesServerToolUseBlock = {
    type: 'server_tool_use',
    id: 'srvtoolu_1',
    name: 'web_search',
    input: { query: 'latest API guide' },
  };

  const webSearchToolResult: MessagesWebSearchToolResultBlock = {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_1',
    content: {
      type: 'web_search_tool_result_error',
      error_code: 'max_uses_exceeded',
    },
  };

  assertEquals(searchCitation.search_result_index, 0);
  assertEquals(searchResult.citations?.enabled, true);
  assertEquals(serverToolUse.name, 'web_search');
  assertEquals(Array.isArray(webSearchToolResult.content), false);
  if (!Array.isArray(webSearchToolResult.content)) {
    assertEquals(webSearchToolResult.content.type, 'web_search_tool_result_error');
  }
});

test('reassembleMessagesEvents reassembles tool_use response', async () => {
  const body = makeEvents([
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_2',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-test',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 20, output_tokens: 0 },
        },
      },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_1', name: 'calc' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"x":' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '42}' },
      },
    },
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 0 },
    },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 10 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);

  const result = await reassembleMessagesEvents(body);

  assertEquals(result.stop_reason, 'tool_use');
  assertEquals(result.content.length, 1);
  assertEquals(result.content[0].type, 'tool_use');
  const tu = result.content[0] as {
    type: 'tool_use';
    id: string;
    name: string;
    input: Record<string, unknown>;
  };
  assertEquals(tu.id, 'tu_1');
  assertEquals(tu.name, 'calc');
  assertEquals(tu.input, { x: 42 });
});

test('reassembleMessagesEvents falls back to empty tool input for malformed JSON', async () => {
  const body = makeEvents([
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_bad_tool_json',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-test',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 20, output_tokens: 0 },
        },
      },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_bad', name: 'calc' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"x":' },
      },
    },
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 0 },
    },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 10 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);

  const result = await reassembleMessagesEvents(body);

  assertEquals(result.content[0], {
    type: 'tool_use',
    id: 'tu_bad',
    name: 'calc',
    input: {},
  });
});

test('reassembleMessagesEvents reassembles thinking blocks', async () => {
  const body = makeEvents([
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_3',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-test',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'let me think' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig_old' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig_123' },
      },
    },
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 0 },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'answer' },
      },
    },
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 1 },
    },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 20 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);

  const result = await reassembleMessagesEvents(body);

  assertEquals(result.content.length, 2);
  assertEquals(result.content[0].type, 'thinking');
  const thinking = result.content[0] as {
    type: 'thinking';
    thinking: string;
    signature?: string;
  };
  assertEquals(thinking.thinking, 'let me think');
  assertEquals(thinking.signature, 'sig_123');
  assertEquals(result.content[1].type, 'text');
});

test('reassembleMessagesEvents omits signature for text-only thinking blocks', async () => {
  const body = makeEvents([
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_text_only_thinking',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-test',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'trace' },
      },
    },
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 0 },
    },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 4 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);

  const result = await reassembleMessagesEvents(body);

  assertEquals(result.content[0], { type: 'thinking', thinking: 'trace' });
});

test('reassembleMessagesEvents throws on error event', async () => {
  const body = makeEvents([
    {
      event: 'error',
      data: {
        type: 'error',
        error: { type: 'overloaded_error', message: 'overloaded' },
      },
    },
  ]);

  await assertRejects(() => reassembleMessagesEvents(body), Error, 'overloaded');
});

test('reassembleMessagesEvents reassembles native web search blocks and usage', async () => {
  const body = makeEvents([
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_ws',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-test',
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 10,
            output_tokens: 0,
            server_tool_use: { web_search_requests: 0 },
          },
        },
      },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'server_tool_use',
          id: 'srvtoolu_1',
          name: 'web_search',
          input: { query: 'Claude Shannon birth date' },
        },
      },
    },
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 0 },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: [
            {
              type: 'web_search_result',
              url: 'https://example.com/shannon',
              title: 'Claude Shannon',
              encrypted_content: 'eyJjb250ZW50IjpbXX0',
              page_age: '2025-04-30',
            },
          ],
        },
      },
    },
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 1 },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'text', text: '' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 2,
        delta: {
          type: 'text_delta',
          text: 'Claude Shannon was born in 1916.',
          citations: [
            {
              type: 'web_search_result_location',
              url: 'https://example.com/shannon',
              title: 'Claude Shannon',
              encrypted_index: 'eyJzZWFyY2hfcmVzdWx0X2luZGV4IjowLCJzdGFydF9ibG9ja19pbmRleCI6MCwiZW5kX2Jsb2NrX2luZGV4IjowfQ',
              cited_text: 'Claude Shannon (1916-2001)',
            },
          ],
        },
      },
    },
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 2 },
    },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'pause_turn', stop_sequence: null },
        usage: {
          output_tokens: 9,
          server_tool_use: { web_search_requests: 1 },
        },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);

  const result = await reassembleMessagesEvents(body);

  assertEquals(result.stop_reason, 'pause_turn');
  assertEquals(result.usage.server_tool_use?.web_search_requests, 1);
  assertEquals(result.content[0].type, 'server_tool_use');
  assertEquals(result.content[1].type, 'web_search_tool_result');
  assertEquals(result.content[2].type, 'text');
  assertEquals((result.content[2] as MessagesTextBlock).citations?.[0]?.type, 'web_search_result_location');
});

test('reassembleMessagesEvents accumulates citations across multiple text deltas', async () => {
  const body = makeEvents([
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_citations',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-test',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 0 },
        },
      },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: 'First sentence. ',
          citations: [
            {
              type: 'web_search_result_location',
              url: 'https://example.com/one',
              title: 'One',
              encrypted_index: 'opaque-first',
              cited_text: 'First source',
            },
          ],
        },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: 'Second sentence.',
          citations: [
            {
              type: 'web_search_result_location',
              url: 'https://example.com/two',
              title: 'Two',
              encrypted_index: 'opaque-second',
              cited_text: 'Second source',
            },
          ],
        },
      },
    },
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 0 },
    },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 4 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);

  const result = await reassembleMessagesEvents(body);
  const block = result.content[0] as MessagesTextBlock;

  assertEquals(block.text, 'First sentence. Second sentence.');
  assertEquals(block.citations?.length, 2);
  assertEquals(block.citations?.[0]?.type, 'web_search_result_location');
  assertEquals(block.citations?.[1]?.type, 'web_search_result_location');
});

test('reassembleMessagesEvents handles citations_delta and normalizes source fields', async () => {
  const body = makeEvents([
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_citations_delta',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-test',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 0 },
        },
      },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '', citations: [] },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'citations_delta',
          citation: {
            type: 'search_result_location',
            source: 'https://example.com/source-only',
            title: 'Source Only',
            search_result_index: 0,
            start_block_index: 0,
            end_block_index: 1,
            cited_text: 'Source-only citation',
          },
        },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Quoted text.' },
      },
    },
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 0 },
    },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 4 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);

  const result = await reassembleMessagesEvents(body);
  const block = result.content[0] as MessagesTextBlock;

  assertEquals(block.text, 'Quoted text.');
  assertEquals(block.citations?.length, 1);
  assertEquals(block.citations?.[0], {
    type: 'search_result_location',
    url: 'https://example.com/source-only',
    title: 'Source Only',
    search_result_index: 0,
    start_block_index: 0,
    end_block_index: 1,
    cited_text: 'Source-only citation',
  });
});

test('reassembleMessagesEvents preserves unknown fields on message_start.message', async () => {
  const body = makeEvents([
    {
      data: {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          usage: { input_tokens: 5, output_tokens: 0 },
          this_is_a_non_standard_field_of_reasoning: 'experimental_value',
          custom_meta: { trace_id: 'abc' },
        },
      },
    },
    { data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } } },
    { data: { type: 'message_stop' } },
  ]);

  const result = await reassembleMessagesEvents(body) as Awaited<ReturnType<typeof reassembleMessagesEvents>> & {
    this_is_a_non_standard_field_of_reasoning?: string;
    custom_meta?: { trace_id: string };
  };
  assertEquals(result.this_is_a_non_standard_field_of_reasoning, 'experimental_value');
  assertEquals(result.custom_meta, { trace_id: 'abc' });
});

test('reassembleMessagesEvents preserves unknown fields on a content_block', async () => {
  const body = makeEvents([
    { data: { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', usage: { input_tokens: 5, output_tokens: 0 } } } },
    {
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: 'hello', vendor_trace: 'opaque-trace-123' },
      },
    },
    { data: { type: 'content_block_stop', index: 0 } },
    { data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } } },
    { data: { type: 'message_stop' } },
  ]);

  const result = await reassembleMessagesEvents(body);
  const block = result.content[0] as { type: string; thinking: string; vendor_trace?: string };
  assertEquals(block.type, 'thinking');
  assertEquals(block.thinking, 'hello');
  assertEquals(block.vendor_trace, 'opaque-trace-123');
});
