import { expect, test } from 'vitest';

import { createMessagesToResponsesStreamState, translateMessagesEventToResponsesEvents } from './events.ts';
import { assertEquals } from '../test-assert.ts';
import { USAGE_BILLING } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

type ResponsesOutputItemAddedEvent = Extract<ResponsesStreamEvent, { type: 'response.output_item.added' }>;

type ResponsesOutputItemDoneEvent = Extract<ResponsesStreamEvent, { type: 'response.output_item.done' }>;

// ── Helpers ──

const runToCompletion = (
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    speed?: string;
    service_tier?: string;
  },
  deltaUsageExtras?: {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
    speed?: string;
    service_tier?: string;
  },
): ResponsesResult => {
  const state = createMessagesToResponsesStreamState('resp_test', 'claude-sonnet-4-20250514');

  translateMessagesEventToResponsesEvents(
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-4-20250514',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: 0,
          cache_read_input_tokens: usage.cache_read_input_tokens,
          cache_creation_input_tokens: usage.cache_creation_input_tokens,
          speed: usage.speed,
          service_tier: usage.service_tier,
        },
      },
    } as MessagesStreamEvent,
    state,
  );

  translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    } as MessagesStreamEvent,
    state,
  );
  translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello' },
    } as MessagesStreamEvent,
    state,
  );
  translateMessagesEventToResponsesEvents({ type: 'content_block_stop', index: 0 } as MessagesStreamEvent, state);
  translateMessagesEventToResponsesEvents(
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: usage.output_tokens, ...deltaUsageExtras },
    } as MessagesStreamEvent,
    state,
  );

  const stopEvents = translateMessagesEventToResponsesEvents({ type: 'message_stop' } as MessagesStreamEvent, state);

  const completed = stopEvents.find(e => e.type === 'response.completed');
  if (completed?.type !== 'response.completed') {
    throw new Error('Expected response.completed event');
  }
  return (
    completed as {
      type: 'response.completed';
      response: ResponsesResult;
    }
  ).response;
};

// ── cache_creation_input_tokens ──

test('includes cache_creation_input_tokens in input_tokens', () => {
  const result = runToCompletion({
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 30,
  });

  assertEquals(result.usage!.input_tokens, 150); // 100 + 20 + 30
  assertEquals(result.usage!.output_tokens, 50);
  assertEquals(result.usage!.total_tokens, 200);
  assertEquals(result.usage!.input_tokens_details, { cached_tokens: 20, cache_write_tokens: 30 });
});

test('handles cache_creation without cache_read', () => {
  const result = runToCompletion({
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: 30,
  });

  assertEquals(result.usage!.input_tokens, 130); // 100 + 0 + 30
  assertEquals(result.usage!.total_tokens, 180);
  assertEquals(result.usage!.input_tokens_details, { cached_tokens: 0, cache_write_tokens: 30 });
});

test('handles no cache fields (backward compat)', () => {
  const result = runToCompletion({
    input_tokens: 100,
    output_tokens: 50,
  });

  assertEquals(result.usage!.input_tokens, 100);
  assertEquals(result.usage!.total_tokens, 150);
  assertEquals(result.usage!.input_tokens_details, undefined);
});

test('redacted_thinking stream block round-trips its opaque data as encrypted_content', () => {
  const state = createMessagesToResponsesStreamState('resp_test', 'claude-test');

  translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'redacted_thinking', data: 'opaque_sig' },
    } as MessagesStreamEvent,
    state,
  );

  translateMessagesEventToResponsesEvents({ type: 'content_block_stop', index: 0 } as MessagesStreamEvent, state);

  assertEquals(state.completedItems, [
    {
      type: 'reasoning',
      id: expect.stringMatching(/^rs_[0-9a-f]{32}$/),
      summary: [],
      encrypted_content: 'opaque_sig',
    },
  ]);
});

test('thinking stream block carries the upstream signature verbatim as encrypted_content', () => {
  const state = createMessagesToResponsesStreamState('resp_test', 'claude-test');

  translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    } as MessagesStreamEvent,
    state,
  );
  translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'trace' },
    } as MessagesStreamEvent,
    state,
  );
  translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'upstream-opaque-signature' },
    } as MessagesStreamEvent,
    state,
  );
  translateMessagesEventToResponsesEvents({ type: 'content_block_stop', index: 0 } as MessagesStreamEvent, state);

  assertEquals(state.completedItems, [
    {
      type: 'reasoning',
      id: expect.stringMatching(/^rs_[0-9a-f]{32}$/),
      summary: [{ type: 'summary_text', text: 'trace' }],
      encrypted_content: 'upstream-opaque-signature',
    },
  ]);
});

test('thinking stream block start emits a plain reasoning item', () => {
  const state = createMessagesToResponsesStreamState('resp_test', 'claude-test');

  const events = translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    } as MessagesStreamEvent,
    state,
  );

  const added = events.find(event => event.type === 'response.output_item.added') as ResponsesOutputItemAddedEvent | undefined;
  if (added?.type !== 'response.output_item.added') {
    throw new Error('expected response.output_item.added event');
  }
  if (added.item.type !== 'reasoning') {
    throw new Error('expected reasoning item');
  }

  assertEquals(added.item, { type: 'reasoning', id: expect.stringMatching(/^rs_[0-9a-f]{32}$/), summary: [] });
});

test('thinking stream block stop emits a plain reasoning item', () => {
  const state = createMessagesToResponsesStreamState('resp_test', 'claude-test');

  translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    } as MessagesStreamEvent,
    state,
  );
  translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'trace' },
    } as MessagesStreamEvent,
    state,
  );
  const events = translateMessagesEventToResponsesEvents({ type: 'content_block_stop', index: 0 } as MessagesStreamEvent, state);

  const done = events.find(event => event.type === 'response.output_item.done') as ResponsesOutputItemDoneEvent | undefined;
  if (done?.type !== 'response.output_item.done') {
    throw new Error('expected response.output_item.done event');
  }
  if (done.item.type !== 'reasoning') {
    throw new Error('expected reasoning item');
  }

  assertEquals(done.item, {
    type: 'reasoning',
    id: expect.stringMatching(/^rs_[0-9a-f]{32}$/),
    summary: [{ type: 'summary_text', text: 'trace' }],
  });
});

test('max_tokens stream stop becomes response.incomplete', () => {
  const state = createMessagesToResponsesStreamState('resp_max_tokens', 'claude-test');

  translateMessagesEventToResponsesEvents(
    {
      type: 'message_start',
      message: {
        id: 'msg_max_tokens',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    } as MessagesStreamEvent,
    state,
  );
  translateMessagesEventToResponsesEvents(
    {
      type: 'message_delta',
      delta: { stop_reason: 'max_tokens' },
      usage: { output_tokens: 7 },
    } as MessagesStreamEvent,
    state,
  );

  const events = translateMessagesEventToResponsesEvents({ type: 'message_stop' } as MessagesStreamEvent, state);

  assertEquals(
    events.map(event => event.type),
    ['response.incomplete'],
  );
  const incomplete = events[0] as Extract<ResponsesStreamEvent, { type: 'response.incomplete' }>;
  if (incomplete.type !== 'response.incomplete') {
    throw new Error('expected response.incomplete');
  }
  assertEquals(incomplete.response.status, 'incomplete');
  assertEquals(incomplete.response.incomplete_details, {
    reason: 'max_output_tokens',
  });
  assertEquals(incomplete.response.usage?.output_tokens, 7);
});

test('unwraps wrapped custom tool calls into custom_tool_call shape', () => {
  const state = createMessagesToResponsesStreamState('resp_ctc', 'claude-test', new Set(['apply_patch']));

  translateMessagesEventToResponsesEvents(
    {
      type: 'message_start',
      message: {
        id: 'msg_ctc',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    } as MessagesStreamEvent,
    state,
  );

  const startEvents = translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'call_ctc', name: 'apply_patch', input: {} },
    } as MessagesStreamEvent,
    state,
  );

  const added = startEvents.find((e): e is ResponsesOutputItemAddedEvent => e.type === 'response.output_item.added');
  if (!added) throw new Error('expected output_item.added');
  assertEquals(added.item.type, 'custom_tool_call');
  if (added.item.type !== 'custom_tool_call') throw new Error('expected custom_tool_call item');
  assertEquals(added.item.name, 'apply_patch');
  assertEquals(added.item.input, '');

  // Wrapped function-tool arguments split across two deltas. The translator
  // buffers without emitting and only surfaces the freeform input at stop time.
  const deltaA = translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"input":"*** Begin Patch' },
    } as MessagesStreamEvent,
    state,
  );
  const deltaB = translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '\\n*** End Patch"}' },
    } as MessagesStreamEvent,
    state,
  );
  assertEquals(deltaA, []);
  assertEquals(deltaB, []);

  const stopEvents = translateMessagesEventToResponsesEvents({ type: 'content_block_stop', index: 0 } as MessagesStreamEvent, state);

  assertEquals(
    stopEvents.map(e => e.type),
    [
      'response.custom_tool_call_input.delta',
      'response.custom_tool_call_input.done',
      'response.output_item.done',
    ],
  );

  const inputDelta = stopEvents[0] as Extract<ResponsesStreamEvent, { type: 'response.custom_tool_call_input.delta' }>;
  const inputDone = stopEvents[1] as Extract<ResponsesStreamEvent, { type: 'response.custom_tool_call_input.done' }>;
  const itemDone = stopEvents[2] as ResponsesOutputItemDoneEvent;

  assertEquals(inputDelta.delta, '*** Begin Patch\n*** End Patch');
  assertEquals(inputDone.input, '*** Begin Patch\n*** End Patch');
  assertEquals(itemDone.item.type, 'custom_tool_call');
  if (itemDone.item.type !== 'custom_tool_call') throw new Error('expected custom_tool_call item');
  assertEquals(itemDone.item.input, '*** Begin Patch\n*** End Patch');
  assertEquals(itemDone.item.call_id, 'call_ctc');
});

// ── citation_delta → response.output_text.annotation.added ──

type AnnotationAddedEvent = Extract<ResponsesStreamEvent, { type: 'response.output_text.annotation.added' }>;

const startTextBlockWithMessage = (state: ReturnType<typeof createMessagesToResponsesStreamState>): void => {
  translateMessagesEventToResponsesEvents(
    {
      type: 'message_start',
      message: {
        id: 'msg_cite',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    } as MessagesStreamEvent,
    state,
  );
  translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    } as MessagesStreamEvent,
    state,
  );
};

const pushTextDelta = (state: ReturnType<typeof createMessagesToResponsesStreamState>, text: string): void => {
  translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    } as MessagesStreamEvent,
    state,
  );
};

test('search_result_location citation_delta becomes one url_citation annotation', () => {
  const state = createMessagesToResponsesStreamState('resp_cite', 'claude-test');
  startTextBlockWithMessage(state);

  pushTextDelta(state, 'See the docs cited inline.');

  const events = translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'citations_delta',
        citation: {
          type: 'search_result_location',
          url: 'https://docs.example.com/page-1',
          title: 'Example Docs · Page 1',
          search_result_index: 0,
          start_block_index: 0,
          end_block_index: 1,
          cited_text: 'cited inline',
        },
      },
    } as MessagesStreamEvent,
    state,
  );

  const annotations = events.filter((e): e is AnnotationAddedEvent => e.type === 'response.output_text.annotation.added');
  assertEquals(annotations.length, 1);
  const [annotation] = annotations;
  assertEquals(annotation.output_index, 0);
  assertEquals(annotation.content_index, 0);
  expect(annotation.item_id).toMatch(/^msg_[0-9a-f]{32}$/);
  assertEquals(annotation.annotation_index, 0);
  assertEquals(annotation.annotation, {
    type: 'url_citation',
    url: 'https://docs.example.com/page-1',
    title: 'Example Docs · Page 1',
    // 'See the docs cited inline.' is 26 chars; 'cited inline' is 12 chars.
    start_index: 14,
    end_index: 26,
  });
});

test('web_search_result_location citation_delta becomes one url_citation annotation', () => {
  const state = createMessagesToResponsesStreamState('resp_cite', 'claude-test');
  startTextBlockWithMessage(state);

  pushTextDelta(state, 'According to MDN.');

  const events = translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'citations_delta',
        citation: {
          type: 'web_search_result_location',
          url: 'https://developer.mozilla.org/en-US/',
          title: 'MDN Web Docs',
          encrypted_index: 'opaque-blob',
          cited_text: 'MDN',
        },
      },
    } as MessagesStreamEvent,
    state,
  );

  const annotations = events.filter((e): e is AnnotationAddedEvent => e.type === 'response.output_text.annotation.added');
  assertEquals(annotations.length, 1);
  assertEquals(annotations[0].annotation, {
    type: 'url_citation',
    url: 'https://developer.mozilla.org/en-US/',
    title: 'MDN Web Docs',
    // 'According to MDN.' is 17 chars; 'MDN' is 3 chars.
    start_index: 14,
    end_index: 17,
  });
});

test('citation_delta without cited_text is skipped', () => {
  const state = createMessagesToResponsesStreamState('resp_cite', 'claude-test');
  startTextBlockWithMessage(state);

  pushTextDelta(state, 'Some text.');

  const events = translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'citations_delta',
        citation: {
          type: 'search_result_location',
          url: 'https://example.com/',
          title: 'Example',
          search_result_index: 0,
          start_block_index: 0,
          end_block_index: 1,
          // cited_text intentionally omitted
        },
      },
    } as MessagesStreamEvent,
    state,
  );

  assertEquals(events, []);
});

test('unknown citation variant is skipped without throwing', () => {
  const state = createMessagesToResponsesStreamState('resp_cite', 'claude-test');
  startTextBlockWithMessage(state);

  pushTextDelta(state, 'Some text.');

  // `char_location` is not currently in our MessagesTextCitation union — it
  // is one of Anthropic's native long-document citation variants. Casting
  // through `unknown` simulates a future protocol addition the translator
  // hasn't been taught about yet; it must drop, not throw.
  const events = translateMessagesEventToResponsesEvents(
    ({
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'citations_delta',
        citation: {
          type: 'char_location',
          document_index: 0,
          document_title: 'A Book',
          start_char_index: 0,
          end_char_index: 5,
          cited_text: 'hello',
        },
      },
    } as unknown) as MessagesStreamEvent,
    state,
  );

  assertEquals(events, []);
});

test('multiple citations on the same text content part get monotonic annotation_index', () => {
  const state = createMessagesToResponsesStreamState('resp_cite', 'claude-test');
  startTextBlockWithMessage(state);

  pushTextDelta(state, 'First quote here.');
  const firstEvents = translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'citations_delta',
        citation: {
          type: 'search_result_location',
          url: 'https://example.com/a',
          title: 'A',
          search_result_index: 0,
          start_block_index: 0,
          end_block_index: 1,
          cited_text: 'quote here',
        },
      },
    } as MessagesStreamEvent,
    state,
  );

  pushTextDelta(state, ' Then a second one.');
  const secondEvents = translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'citations_delta',
        citation: {
          type: 'web_search_result_location',
          url: 'https://example.com/b',
          title: 'B',
          encrypted_index: 'blob',
          cited_text: 'second one',
        },
      },
    } as MessagesStreamEvent,
    state,
  );

  const [firstAnn] = firstEvents.filter((e): e is AnnotationAddedEvent => e.type === 'response.output_text.annotation.added');
  const [secondAnn] = secondEvents.filter((e): e is AnnotationAddedEvent => e.type === 'response.output_text.annotation.added');

  assertEquals(firstAnn.annotation_index, 0);
  assertEquals(secondAnn.annotation_index, 1);
  // Sequence numbers must keep advancing across the two citations.
  assertEquals((firstAnn.sequence_number ?? -1) < (secondAnn.sequence_number ?? -1), true);
});

test('citation offsets reflect running text length up to the citation_delta', () => {
  const state = createMessagesToResponsesStreamState('resp_cite', 'claude-test');
  startTextBlockWithMessage(state);

  pushTextDelta(state, 'Intro text. ');
  pushTextDelta(state, 'Then "quoted text"');

  const events = translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'citations_delta',
        citation: {
          type: 'search_result_location',
          url: 'https://example.com/q',
          title: 'Q',
          search_result_index: 0,
          start_block_index: 0,
          end_block_index: 1,
          cited_text: '"quoted text"',
        },
      },
    } as MessagesStreamEvent,
    state,
  );

  const [annotation] = events.filter((e): e is AnnotationAddedEvent => e.type === 'response.output_text.annotation.added');
  // 'Intro text. Then "quoted text"' is 30 chars; '"quoted text"' is 13.
  assertEquals(annotation.annotation.start_index, 17);
  assertEquals(annotation.annotation.end_index, 30);
});

test('text_delta events on a text block with citations still emit text deltas unchanged', () => {
  const state = createMessagesToResponsesStreamState('resp_cite', 'claude-test');
  startTextBlockWithMessage(state);

  const deltaEvents = translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello world.' },
    } as MessagesStreamEvent,
    state,
  );

  const textDeltas = deltaEvents.filter(e => e.type === 'response.output_text.delta');
  assertEquals(textDeltas.length, 1);

  // A citation arriving afterwards must not interfere with the next text
  // delta on the same block.
  translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'citations_delta',
        citation: {
          type: 'search_result_location',
          url: 'https://example.com/',
          title: 'X',
          search_result_index: 0,
          start_block_index: 0,
          end_block_index: 1,
          cited_text: 'world',
        },
      },
    } as MessagesStreamEvent,
    state,
  );

  const more = translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: ' More.' },
    } as MessagesStreamEvent,
    state,
  );

  const moreTextDeltas = more.filter(e => e.type === 'response.output_text.delta');
  assertEquals(moreTextDeltas.length, 1);
  assertEquals(state.accumulatedText, 'Hello world. More.');
});

// ── Synthesized output items carry stable, child-consistent ids ──
//
// When a Responses client is routed to a Messages upstream, every synthesized
// output item must expose an id so the source-serve persistence layer can mint
// a stored id and record the item. The id on `output_item.added`/`.done` must
// match the `item_id` on every child frame, and stay stable within the
// response (index-derived, not a fresh gateway stored id).

const itemIdOf = (events: ResponsesStreamEvent[], type: 'response.output_item.added' | 'response.output_item.done'): string => {
  const event = events.find(candidate => candidate.type === type) as (ResponsesOutputItemAddedEvent | ResponsesOutputItemDoneEvent) | undefined;
  if (!event) throw new Error(`expected ${type}`);
  const id = (event.item as { id?: string }).id;
  if (id === undefined) throw new Error(`expected ${type} item to carry an id`);
  return id;
};

const childItemIds = (events: ResponsesStreamEvent[]): string[] =>
  events
    .filter(event => event.type !== 'response.output_item.added' && event.type !== 'response.output_item.done')
    .map(event => (event as { item_id?: string }).item_id)
    .filter((id): id is string => id !== undefined);

test('synthesized message item carries a stable id consistent across added, child, and done frames', () => {
  const state = createMessagesToResponsesStreamState('resp_test', 'claude-test');

  const startEvents = translateMessagesEventToResponsesEvents(
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as MessagesStreamEvent,
    state,
  );
  const deltaEvents = translateMessagesEventToResponsesEvents(
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } as MessagesStreamEvent,
    state,
  );
  const stopEvents = translateMessagesEventToResponsesEvents({ type: 'content_block_stop', index: 0 } as MessagesStreamEvent, state);

  const addedId = itemIdOf(startEvents, 'response.output_item.added');
  const doneId = itemIdOf(stopEvents, 'response.output_item.done');
  const allChildIds = [...childItemIds(startEvents), ...childItemIds(deltaEvents), ...childItemIds(stopEvents)];

  expect(addedId).toMatch(/^msg_[0-9a-f]{32}$/);
  assertEquals(doneId, addedId);
  assertEquals(new Set(allChildIds), new Set([addedId]));
  assertEquals(state.completedItems, [
    { type: 'message', id: addedId, role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
  ]);
});

test('synthesized function_call item carries a stable id consistent across added, child, and done frames', () => {
  const state = createMessagesToResponsesStreamState('resp_test', 'claude-test');

  const startEvents = translateMessagesEventToResponsesEvents(
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} } } as MessagesStreamEvent,
    state,
  );
  const deltaEvents = translateMessagesEventToResponsesEvents(
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' } } as MessagesStreamEvent,
    state,
  );
  const stopEvents = translateMessagesEventToResponsesEvents({ type: 'content_block_stop', index: 0 } as MessagesStreamEvent, state);

  const addedId = itemIdOf(startEvents, 'response.output_item.added');
  const doneId = itemIdOf(stopEvents, 'response.output_item.done');
  const allChildIds = [...childItemIds(startEvents), ...childItemIds(deltaEvents), ...childItemIds(stopEvents)];

  expect(addedId).toMatch(/^fc_[0-9a-f]{32}$/);
  assertEquals(doneId, addedId);
  assertEquals(new Set(allChildIds), new Set([addedId]));
  assertEquals(state.completedItems, [
    { type: 'function_call', id: addedId, call_id: 'toolu_1', name: 'lookup', arguments: '{"q":"x"}', status: 'completed' },
  ]);
});

// ── speed / service_tier pass-through ──

test('Anthropic speed:fast maps to service_tier:fast on the Responses result', () => {
  const result = runToCompletion({ input_tokens: 10, output_tokens: 5 }, { speed: 'fast' });

  assertEquals(result.service_tier, 'fast');
});

test('Anthropic service_tier:standard with no speed passes service_tier:standard through', () => {
  const result = runToCompletion({ input_tokens: 10, output_tokens: 5 }, { service_tier: 'standard' });

  assertEquals(result.service_tier, 'standard');
});

test('Anthropic service_tier absent results in no service_tier on the Responses result', () => {
  const result = runToCompletion({ input_tokens: 10, output_tokens: 5 });

  assertEquals(result.service_tier, undefined);
});

test('Messages message_start service_tier survives when message_delta omits it', () => {
  const result = runToCompletion({ input_tokens: 10, output_tokens: 5, service_tier: 'priority' });
  assertEquals(result.service_tier, 'priority');
});

test('Messages message_start speed:fast survives when message_delta omits it', () => {
  const result = runToCompletion({ input_tokens: 10, output_tokens: 5, speed: 'fast' });
  assertEquals(result.service_tier, 'fast');
});

test('Messages delta atomically replaces tier and merges late cache accounting into Responses', () => {
  const result = runToCompletion(
    { input_tokens: 0, output_tokens: 2, cache_creation_input_tokens: 9, speed: 'fast' },
    {
      input_tokens: 11,
      cache_creation: { ephemeral_1h_input_tokens: 5 },
      service_tier: 'priority',
    },
  );
  assertEquals(result.service_tier, 'priority');
  assertEquals(result.usage, {
    input_tokens: 20,
    output_tokens: 2,
    total_tokens: 22,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 9 },
    [USAGE_BILLING]: { cacheWrite1hTokenCount: 5 },
  });
});
