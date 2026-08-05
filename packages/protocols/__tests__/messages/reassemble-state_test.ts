import { expect, test } from 'vitest';

import type { MessagesStreamEvent } from '../../src/messages/index.ts';
import { reassembleMessagesEvents } from '../../src/messages/reassemble.ts';

const eventsFrom = async function* (events: readonly MessagesStreamEvent[]) {
  yield* events;
};

const messageStart = (usage: Record<string, unknown> = { input_tokens: 1, output_tokens: 0 }): MessagesStreamEvent => ({
  type: 'message_start',
  message: {
    id: 'msg_state',
    type: 'message',
    role: 'assistant',
    content: [],
    model: 'claude-test',
    stop_reason: null,
    stop_sequence: null,
    usage: usage as never,
  },
});

test('Messages reassembly preserves nested usage and initial thinking signatures', async () => {
  const result = await reassembleMessagesEvents(eventsFrom([
    messageStart({ input_tokens: 1, output_tokens: 0, output_tokens_details: { thinking_tokens: 7 } }),
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'thought', signature: 'sig_start' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ]));

  expect(result.usage.output_tokens_details).toEqual({ thinking_tokens: 7 });
  expect(result.content).toEqual([{ type: 'thinking', thinking: 'thought', signature: 'sig_start' }]);
});

test('Messages reassembly accepts nullable text citations', async () => {
  const result = await reassembleMessagesEvents(eventsFrom([
    messageStart(),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: null } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ]));
  expect(result.content).toEqual([{ type: 'text', text: '' }]);
});

test.each([
  {
    citation: { type: 'char_location', cited_text: 'quote', document_index: 0, document_title: null, start_char_index: 0, end_char_index: 5, file_id: null },
    expected: { type: 'char_location', cited_text: 'quote', document_index: 0, document_title: null, start_char_index: 0, end_char_index: 5, file_id: null },
  },
  {
    citation: { type: 'content_block_location', cited_text: 'quote', document_index: 0, document_title: null, start_block_index: 0, end_block_index: 1, file_id: null },
    expected: { type: 'content_block_location', cited_text: 'quote', document_index: 0, document_title: null, start_block_index: 0, end_block_index: 1, file_id: null },
  },
  {
    citation: { type: 'page_location', cited_text: 'quote', document_index: 0, document_title: null, start_page_number: 1, end_page_number: 1, file_id: null },
    expected: { type: 'page_location', cited_text: 'quote', document_index: 0, document_title: null, start_page_number: 1, end_page_number: 1, file_id: null },
  },
  {
    citation: { type: 'search_result_location', cited_text: 'quote', search_result_index: 0, source: 'https://example.com', title: null, start_block_index: 0, end_block_index: 1, vendor: { trace: 'kept' } },
    expected: { type: 'search_result_location', cited_text: 'quote', search_result_index: 0, url: 'https://example.com', title: null, start_block_index: 0, end_block_index: 1, vendor: { trace: 'kept' } },
  },
] as const)('Messages reassembly preserves current $citation.type citations', async ({ citation, expected }) => {
  const result = await reassembleMessagesEvents(eventsFrom([
    messageStart(),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation: citation as never } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ]));
  expect(result.content[0]).toEqual({ type: 'text', text: '', citations: [expected] });
});

test.each([
  { type: 'web_fetch_tool_result', tool_use_id: 'tool_1', content: { type: 'web_fetch_tool_result_error', error_code: 'unavailable' } },
  { type: 'code_execution_tool_result', tool_use_id: 'tool_2', content: { type: 'code_execution_tool_result_error', error_code: 'unavailable' } },
  { type: 'bash_code_execution_tool_result', tool_use_id: 'tool_3', content: { type: 'bash_code_execution_tool_result_error', error_code: 'unavailable' } },
  { type: 'text_editor_code_execution_tool_result', tool_use_id: 'tool_4', content: { type: 'text_editor_code_execution_tool_result_error', error_code: 'unavailable' } },
  { type: 'tool_search_tool_result', tool_use_id: 'tool_5', content: { type: 'tool_search_tool_result_error', error_code: 'unavailable' } },
  { type: 'container_upload', file_id: 'file_123', extras: { vendor: 'kept' } },
] as const)('Messages reassembly preserves current opaque $type output blocks', async contentBlock => {
  const result = await reassembleMessagesEvents(eventsFrom([
    messageStart(),
    { type: 'content_block_start', index: 0, content_block: contentBlock },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ]));
  expect(result.content).toEqual([contentBlock]);
});

test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
  'Messages reassembly rejects invalid content block index %s',
  async index => {
    await expect(reassembleMessagesEvents(eventsFrom([
      messageStart(),
      { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    ]))).rejects.toThrow('non-negative safe integer');
  },
);

test('Messages reassembly rejects gaps without allocating sparse content arrays', async () => {
  await expect(reassembleMessagesEvents(eventsFrom([
    messageStart(),
    { type: 'content_block_start', index: 1_000_000, content_block: { type: 'text', text: 'bounded' } },
    { type: 'content_block_stop', index: 1_000_000 },
    { type: 'message_stop' },
  ]))).rejects.toThrow('missing index 0');
});

test('Messages reassembly rejects impossible block event orderings', async () => {
  await expect(reassembleMessagesEvents(eventsFrom([
    messageStart(),
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'early' } },
  ]))).rejects.toThrow('before its start event');

  await expect(reassembleMessagesEvents(eventsFrom([
    messageStart(),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
  ]))).rejects.toThrow('cannot update a text block');

  await expect(reassembleMessagesEvents(eventsFrom([
    messageStart(),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'message_stop' },
  ]))).rejects.toThrow('remained open');
});

test('Messages reassembly rejects semantically invalid tool input and citations', async () => {
  await expect(reassembleMessagesEvents(eventsFrom([
    messageStart(),
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool', name: 'run', input: null as never } },
  ]))).rejects.toThrow('must be a JSON object');

  await expect(reassembleMessagesEvents(eventsFrom([
    messageStart(),
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool', name: 'run', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'null' } },
    { type: 'content_block_stop', index: 0 },
  ]))).rejects.toThrow('must be a JSON object');

  await expect(reassembleMessagesEvents(eventsFrom([
    messageStart(),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: [{ type: 'future' } as never] } },
  ]))).rejects.toThrow('Unsupported Messages text citation type');

  await expect(reassembleMessagesEvents(eventsFrom([
    messageStart(),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'citations_delta',
        citation: {
          type: 'content_block_location', cited_text: 'backwards', document_index: 0, document_title: null, start_block_index: 2, end_block_index: 1,
        } as never,
      },
    },
  ]))).rejects.toThrow('content_block_location citation is malformed');
});

test('Messages reassembly rejects terminal metadata while a block is open and any later state mutation', async () => {
  await expect(reassembleMessagesEvents(eventsFrom([
    messageStart(),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  ]))).rejects.toThrow('remained open at terminal message_delta');

  await expect(reassembleMessagesEvents(eventsFrom([
    messageStart(),
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'late' } },
  ]))).rejects.toThrow('after its terminal message_delta');
});

test('Messages reassembly rejects unknown runtime event and delta variants', async () => {
  await expect(reassembleMessagesEvents(eventsFrom([
    messageStart(),
    { type: 'future_event' } as never,
  ]))).rejects.toThrow('Unsupported Messages stream event type');
  await expect(reassembleMessagesEvents(eventsFrom([
    messageStart(),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'future_delta' } } as never,
  ]))).rejects.toThrow('Unsupported Messages content block delta type');
});

test('Messages reassembly rejects malformed output fallback boundaries', async () => {
  await expect(reassembleMessagesEvents(eventsFrom([
    messageStart(),
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'fallback', from: { model: 'claude-new' }, to: { model: 'claude-old' }, trigger: null,
      } as never,
    },
  ]))).rejects.toThrow('fallback block is malformed');
});

test('Messages reassembly validates every known block and delta field before folding', async () => {
  const rejectBlock = async (content_block: Record<string, unknown>, message: string) => {
    await expect(reassembleMessagesEvents(eventsFrom([
      messageStart(),
      { type: 'content_block_start', index: 0, content_block } as never,
    ]))).rejects.toThrow(message);
  };
  const rejectDelta = async (content_block: Record<string, unknown>, delta: Record<string, unknown>, message: string) => {
    await expect(reassembleMessagesEvents(eventsFrom([
      messageStart(),
      { type: 'content_block_start', index: 0, content_block } as never,
      { type: 'content_block_delta', index: 0, delta } as never,
    ]))).rejects.toThrow(message);
  };

  await rejectBlock({ type: 'text', text: 1 }, 'text block text must be a string');
  await rejectBlock({ type: 'tool_use', id: '', name: 'run', input: {} }, 'tool_use.id must be a non-empty string');
  await rejectBlock({ type: 'server_tool_use', id: '', name: 'web_search', input: { query: 'docs' } }, 'server_tool_use.id must be a non-empty string');
  await rejectBlock({ type: 'thinking', thinking: 1 }, 'thinking block thinking must be a string');
  await rejectBlock({ type: 'redacted_thinking', data: {} }, 'redacted_thinking.data must be a string');
  await rejectDelta({ type: 'text', text: '' }, { type: 'text_delta', text: 1 }, 'text_delta.text must be a string');
  await rejectDelta({ type: 'tool_use', id: 'tool', name: 'run', input: {} }, { type: 'input_json_delta', partial_json: {} }, 'partial_json must be a string');
  await rejectDelta({ type: 'thinking', thinking: '' }, { type: 'signature_delta', signature: 1 }, 'signature_delta.signature must be a string');
});

test('Messages reassembly requires the terminal message_stop event', async () => {
  await expect(reassembleMessagesEvents(eventsFrom([messageStart()]))).rejects.toThrow('without a message_stop event');
});
