import { expect, test } from 'vitest';

import { createAnthropicMessagesToOpenAIResponsesStreamState, translateAnthropicMessagesEventToOpenAIResponsesEvents } from '../../src/openai-responses-via-anthropic-messages/events.ts';
import type { AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIResponsesResult, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import { assertEquals } from '@floway-dev/test-utils';

type OpenAIResponsesOutputItemAddedEvent = Extract<OpenAIResponsesStreamEvent, { type: 'response.output_item.added' }>;

type OpenAIResponsesOutputItemDoneEvent = Extract<OpenAIResponsesStreamEvent, { type: 'response.output_item.done' }>;

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
    output_tokens_details?: { thinking_tokens: number };
    speed?: string;
    service_tier?: string;
  },
): OpenAIResponsesResult => {
  const state = createAnthropicMessagesToOpenAIResponsesStreamState('resp_test', 'claude-sonnet-4-20250514');

  translateAnthropicMessagesEventToOpenAIResponsesEvents(
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
    } as AnthropicMessagesStreamEvent,
    state,
  );

  translateAnthropicMessagesEventToOpenAIResponsesEvents(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    } as AnthropicMessagesStreamEvent,
    state,
  );
  translateAnthropicMessagesEventToOpenAIResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello' },
    } as AnthropicMessagesStreamEvent,
    state,
  );
  translateAnthropicMessagesEventToOpenAIResponsesEvents({ type: 'content_block_stop', index: 0 } as AnthropicMessagesStreamEvent, state);
  translateAnthropicMessagesEventToOpenAIResponsesEvents(
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: usage.output_tokens, ...deltaUsageExtras },
    } as AnthropicMessagesStreamEvent,
    state,
  );

  const stopEvents = translateAnthropicMessagesEventToOpenAIResponsesEvents({ type: 'message_stop' } as AnthropicMessagesStreamEvent, state);

  const completed = stopEvents.find(e => e.type === 'response.completed');
  if (completed?.type !== 'response.completed') {
    throw new Error('Expected response.completed event');
  }
  return (
    completed as {
      type: 'response.completed';
      response: OpenAIResponsesResult;
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
  assertEquals(result.usage!.output_tokens_details, undefined);
});

// ── output_tokens_details ──

test('maps Anthropic Messages thinking_tokens onto OpenAI Responses reasoning_tokens', () => {
  const result = runToCompletion(
    { input_tokens: 10, output_tokens: 60 },
    { output_tokens_details: { thinking_tokens: 45 } },
  );

  assertEquals(result.usage!.output_tokens, 60);
  assertEquals(result.usage!.output_tokens_details, { reasoning_tokens: 45 });
});

test('redacted_thinking stream block round-trips its opaque data as encrypted_content', () => {
  const state = createAnthropicMessagesToOpenAIResponsesStreamState('resp_test', 'claude-test');

  translateAnthropicMessagesEventToOpenAIResponsesEvents(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'redacted_thinking', data: 'opaque_sig' },
    } as AnthropicMessagesStreamEvent,
    state,
  );

  translateAnthropicMessagesEventToOpenAIResponsesEvents({ type: 'content_block_stop', index: 0 } as AnthropicMessagesStreamEvent, state);

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
  const state = createAnthropicMessagesToOpenAIResponsesStreamState('resp_test', 'claude-test');

  translateAnthropicMessagesEventToOpenAIResponsesEvents(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    } as AnthropicMessagesStreamEvent,
    state,
  );
  translateAnthropicMessagesEventToOpenAIResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'trace' },
    } as AnthropicMessagesStreamEvent,
    state,
  );
  translateAnthropicMessagesEventToOpenAIResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'upstream-opaque-signature' },
    } as AnthropicMessagesStreamEvent,
    state,
  );
  translateAnthropicMessagesEventToOpenAIResponsesEvents({ type: 'content_block_stop', index: 0 } as AnthropicMessagesStreamEvent, state);

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
  const state = createAnthropicMessagesToOpenAIResponsesStreamState('resp_test', 'claude-test');

  const events = translateAnthropicMessagesEventToOpenAIResponsesEvents(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    } as AnthropicMessagesStreamEvent,
    state,
  );

  const added = events.find(event => event.type === 'response.output_item.added') as OpenAIResponsesOutputItemAddedEvent | undefined;
  if (added?.type !== 'response.output_item.added') {
    throw new Error('expected response.output_item.added event');
  }
  if (added.item.type !== 'reasoning') {
    throw new Error('expected reasoning item');
  }

  assertEquals(added.item, { type: 'reasoning', id: expect.stringMatching(/^rs_[0-9a-f]{32}$/), summary: [] });
});

test('thinking stream block stop emits a plain reasoning item', () => {
  const state = createAnthropicMessagesToOpenAIResponsesStreamState('resp_test', 'claude-test');

  translateAnthropicMessagesEventToOpenAIResponsesEvents(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    } as AnthropicMessagesStreamEvent,
    state,
  );
  translateAnthropicMessagesEventToOpenAIResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'trace' },
    } as AnthropicMessagesStreamEvent,
    state,
  );
  const events = translateAnthropicMessagesEventToOpenAIResponsesEvents({ type: 'content_block_stop', index: 0 } as AnthropicMessagesStreamEvent, state);

  const done = events.find(event => event.type === 'response.output_item.done') as OpenAIResponsesOutputItemDoneEvent | undefined;
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
  const state = createAnthropicMessagesToOpenAIResponsesStreamState('resp_max_tokens', 'claude-test');

  translateAnthropicMessagesEventToOpenAIResponsesEvents(
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
    } as AnthropicMessagesStreamEvent,
    state,
  );
  translateAnthropicMessagesEventToOpenAIResponsesEvents(
    {
      type: 'message_delta',
      delta: { stop_reason: 'max_tokens' },
      usage: { output_tokens: 7 },
    } as AnthropicMessagesStreamEvent,
    state,
  );

  const events = translateAnthropicMessagesEventToOpenAIResponsesEvents({ type: 'message_stop' } as AnthropicMessagesStreamEvent, state);

  assertEquals(
    events.map(event => event.type),
    ['response.incomplete'],
  );
  const incomplete = events[0] as Extract<OpenAIResponsesStreamEvent, { type: 'response.incomplete' }>;
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
  const state = createAnthropicMessagesToOpenAIResponsesStreamState('resp_ctc', 'claude-test', new Set(['apply_patch']));

  translateAnthropicMessagesEventToOpenAIResponsesEvents(
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
    } as AnthropicMessagesStreamEvent,
    state,
  );

  const startEvents = translateAnthropicMessagesEventToOpenAIResponsesEvents(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'call_ctc', name: 'apply_patch', input: {} },
    } as AnthropicMessagesStreamEvent,
    state,
  );

  const added = startEvents.find((e): e is OpenAIResponsesOutputItemAddedEvent => e.type === 'response.output_item.added');
  if (!added) throw new Error('expected output_item.added');
  assertEquals(added.item.type, 'custom_tool_call');
  if (added.item.type !== 'custom_tool_call') throw new Error('expected custom_tool_call item');
  assertEquals(added.item.name, 'apply_patch');
  assertEquals(added.item.input, '');

  // Wrapped function-tool arguments split across two deltas. The translator
  // buffers without emitting and only surfaces the freeform input at stop time.
  const deltaA = translateAnthropicMessagesEventToOpenAIResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"input":"*** Begin Patch' },
    } as AnthropicMessagesStreamEvent,
    state,
  );
  const deltaB = translateAnthropicMessagesEventToOpenAIResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '\\n*** End Patch"}' },
    } as AnthropicMessagesStreamEvent,
    state,
  );
  assertEquals(deltaA, []);
  assertEquals(deltaB, []);

  const stopEvents = translateAnthropicMessagesEventToOpenAIResponsesEvents({ type: 'content_block_stop', index: 0 } as AnthropicMessagesStreamEvent, state);

  assertEquals(
    stopEvents.map(e => e.type),
    [
      'response.custom_tool_call_input.delta',
      'response.custom_tool_call_input.done',
      'response.output_item.done',
    ],
  );

  const inputDelta = stopEvents[0] as Extract<OpenAIResponsesStreamEvent, { type: 'response.custom_tool_call_input.delta' }>;
  const inputDone = stopEvents[1] as Extract<OpenAIResponsesStreamEvent, { type: 'response.custom_tool_call_input.done' }>;
  const itemDone = stopEvents[2] as OpenAIResponsesOutputItemDoneEvent;

  assertEquals(inputDelta.delta, '*** Begin Patch\n*** End Patch');
  assertEquals(inputDone.input, '*** Begin Patch\n*** End Patch');
  assertEquals(itemDone.item.type, 'custom_tool_call');
  if (itemDone.item.type !== 'custom_tool_call') throw new Error('expected custom_tool_call item');
  assertEquals(itemDone.item.input, '*** Begin Patch\n*** End Patch');
  assertEquals(itemDone.item.call_id, 'call_ctc');
});

// ── citation_delta → response.output_text.annotation.added ──

type AnnotationAddedEvent = Extract<OpenAIResponsesStreamEvent, { type: 'response.output_text.annotation.added' }>;

const startTextBlockWithMessage = (state: ReturnType<typeof createAnthropicMessagesToOpenAIResponsesStreamState>): void => {
  translateAnthropicMessagesEventToOpenAIResponsesEvents(
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
    } as AnthropicMessagesStreamEvent,
    state,
  );
  translateAnthropicMessagesEventToOpenAIResponsesEvents(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    } as AnthropicMessagesStreamEvent,
    state,
  );
};

const pushTextDelta = (state: ReturnType<typeof createAnthropicMessagesToOpenAIResponsesStreamState>, text: string): void => {
  translateAnthropicMessagesEventToOpenAIResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    } as AnthropicMessagesStreamEvent,
    state,
  );
};

test('search_result_location citation_delta becomes one url_citation annotation', () => {
  const state = createAnthropicMessagesToOpenAIResponsesStreamState('resp_cite', 'claude-test');
  startTextBlockWithMessage(state);

  pushTextDelta(state, 'See the docs cited inline.');

  const events = translateAnthropicMessagesEventToOpenAIResponsesEvents(
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
    } as AnthropicMessagesStreamEvent,
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
  const state = createAnthropicMessagesToOpenAIResponsesStreamState('resp_cite', 'claude-test');
  startTextBlockWithMessage(state);

  pushTextDelta(state, 'According to MDN.');

  const events = translateAnthropicMessagesEventToOpenAIResponsesEvents(
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
    } as AnthropicMessagesStreamEvent,
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
  const state = createAnthropicMessagesToOpenAIResponsesStreamState('resp_cite', 'claude-test');
  startTextBlockWithMessage(state);

  pushTextDelta(state, 'Some text.');

  const events = translateAnthropicMessagesEventToOpenAIResponsesEvents(
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
    } as AnthropicMessagesStreamEvent,
    state,
  );

  assertEquals(events, []);
});

test('unknown citation variant is skipped without throwing', () => {
  const state = createAnthropicMessagesToOpenAIResponsesStreamState('resp_cite', 'claude-test');
  startTextBlockWithMessage(state);

  pushTextDelta(state, 'Some text.');

  // `char_location` is not currently in our AnthropicMessagesTextCitation union — it
  // is one of Anthropic's native long-document citation variants. Casting
  // through `unknown` simulates a future protocol addition the translator
  // hasn't been taught about yet; it must drop, not throw.
  const events = translateAnthropicMessagesEventToOpenAIResponsesEvents(
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
    } as unknown) as AnthropicMessagesStreamEvent,
    state,
  );

  assertEquals(events, []);
});

test('multiple citations on the same text content part get monotonic annotation_index', () => {
  const state = createAnthropicMessagesToOpenAIResponsesStreamState('resp_cite', 'claude-test');
  startTextBlockWithMessage(state);

  pushTextDelta(state, 'First quote here.');
  const firstEvents = translateAnthropicMessagesEventToOpenAIResponsesEvents(
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
    } as AnthropicMessagesStreamEvent,
    state,
  );

  pushTextDelta(state, ' Then a second one.');
  const secondEvents = translateAnthropicMessagesEventToOpenAIResponsesEvents(
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
    } as AnthropicMessagesStreamEvent,
    state,
  );

  const [firstAnn] = firstEvents.filter((e): e is AnnotationAddedEvent => e.type === 'response.output_text.annotation.added');
  const [secondAnn] = secondEvents.filter((e): e is AnnotationAddedEvent => e.type === 'response.output_text.annotation.added');

  assertEquals(firstAnn.annotation_index, 0);
  assertEquals(secondAnn.annotation_index, 1);
  // Sequence numbers must keep advancing across the two citations.
  assertEquals((firstAnn.sequence_number ?? -1) < (secondAnn.sequence_number ?? -1), true);
});

test('accumulated citations land on the completed content part and output item', () => {
  const state = createAnthropicMessagesToOpenAIResponsesStreamState('resp_cite', 'claude-test');
  startTextBlockWithMessage(state);

  pushTextDelta(state, 'First quote here.');
  translateAnthropicMessagesEventToOpenAIResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'citations_delta',
        citation: {
          type: 'web_search_result_location',
          url: 'https://example.com/a',
          title: 'A',
          encrypted_index: 'blob',
          cited_text: 'quote here',
        },
      },
    } as AnthropicMessagesStreamEvent,
    state,
  );

  const stopEvents = translateAnthropicMessagesEventToOpenAIResponsesEvents({ type: 'content_block_stop', index: 0 } as AnthropicMessagesStreamEvent, state);

  const annotations = [{ type: 'url_citation', url: 'https://example.com/a', title: 'A', start_index: 7, end_index: 17 }];
  const partDone = stopEvents.find(event => event.type === 'response.content_part.done') as Extract<OpenAIResponsesStreamEvent, { type: 'response.content_part.done' }>;
  assertEquals(partDone.part, { type: 'output_text', text: 'First quote here.', annotations });
  assertEquals(state.completedItems, [
    { type: 'message', id: partDone.item_id, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'First quote here.', annotations }] },
  ]);
});

test('citation offsets reflect running text length up to the citation_delta', () => {
  const state = createAnthropicMessagesToOpenAIResponsesStreamState('resp_cite', 'claude-test');
  startTextBlockWithMessage(state);

  pushTextDelta(state, 'Intro text. ');
  pushTextDelta(state, 'Then "quoted text"');

  const events = translateAnthropicMessagesEventToOpenAIResponsesEvents(
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
    } as AnthropicMessagesStreamEvent,
    state,
  );

  const [annotation] = events.filter((e): e is AnnotationAddedEvent => e.type === 'response.output_text.annotation.added');
  // 'Intro text. Then "quoted text"' is 30 chars; '"quoted text"' is 13.
  assertEquals(annotation.annotation.start_index, 17);
  assertEquals(annotation.annotation.end_index, 30);
});

test('text_delta events on a text block with citations still emit text deltas unchanged', () => {
  const state = createAnthropicMessagesToOpenAIResponsesStreamState('resp_cite', 'claude-test');
  startTextBlockWithMessage(state);

  const deltaEvents = translateAnthropicMessagesEventToOpenAIResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello world.' },
    } as AnthropicMessagesStreamEvent,
    state,
  );

  const textDeltas = deltaEvents.filter(e => e.type === 'response.output_text.delta');
  assertEquals(textDeltas.length, 1);

  // A citation arriving afterwards must not interfere with the next text
  // delta on the same block.
  translateAnthropicMessagesEventToOpenAIResponsesEvents(
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
    } as AnthropicMessagesStreamEvent,
    state,
  );

  const more = translateAnthropicMessagesEventToOpenAIResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: ' More.' },
    } as AnthropicMessagesStreamEvent,
    state,
  );

  const moreTextDeltas = more.filter(e => e.type === 'response.output_text.delta');
  assertEquals(moreTextDeltas.length, 1);
  assertEquals(state.accumulatedText, 'Hello world. More.');
});

// ── Synthesized output items carry stable, child-consistent ids ──

const itemIdOf = (events: OpenAIResponsesStreamEvent[], type: 'response.output_item.added' | 'response.output_item.done'): string => {
  const event = events.find(candidate => candidate.type === type) as (OpenAIResponsesOutputItemAddedEvent | OpenAIResponsesOutputItemDoneEvent) | undefined;
  if (!event) throw new Error(`expected ${type}`);
  const id = (event.item as { id?: string }).id;
  if (id === undefined) throw new Error(`expected ${type} item to carry an id`);
  return id;
};

const childItemIds = (events: OpenAIResponsesStreamEvent[]): string[] =>
  events
    .filter(event => event.type !== 'response.output_item.added' && event.type !== 'response.output_item.done')
    .map(event => (event as { item_id?: string }).item_id)
    .filter((id): id is string => id !== undefined);

test('synthesized message item carries a stable id consistent across added, child, and done frames', () => {
  const state = createAnthropicMessagesToOpenAIResponsesStreamState('resp_test', 'claude-test');

  const startEvents = translateAnthropicMessagesEventToOpenAIResponsesEvents(
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as AnthropicMessagesStreamEvent,
    state,
  );
  const deltaEvents = translateAnthropicMessagesEventToOpenAIResponsesEvents(
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } as AnthropicMessagesStreamEvent,
    state,
  );
  const stopEvents = translateAnthropicMessagesEventToOpenAIResponsesEvents({ type: 'content_block_stop', index: 0 } as AnthropicMessagesStreamEvent, state);

  const addedId = itemIdOf(startEvents, 'response.output_item.added');
  const doneId = itemIdOf(stopEvents, 'response.output_item.done');
  const allChildIds = [...childItemIds(startEvents), ...childItemIds(deltaEvents), ...childItemIds(stopEvents)];

  expect(addedId).toMatch(/^msg_[0-9a-f]{32}$/);
  assertEquals(doneId, addedId);
  assertEquals(new Set(allChildIds), new Set([addedId]));
  assertEquals(state.completedItems, [
    { type: 'message', id: addedId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'hi', annotations: [] }] },
  ]);
});

test('synthesized function_call item carries a stable id consistent across added, child, and done frames', () => {
  const state = createAnthropicMessagesToOpenAIResponsesStreamState('resp_test', 'claude-test');

  const startEvents = translateAnthropicMessagesEventToOpenAIResponsesEvents(
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} } } as AnthropicMessagesStreamEvent,
    state,
  );
  const deltaEvents = translateAnthropicMessagesEventToOpenAIResponsesEvents(
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' } } as AnthropicMessagesStreamEvent,
    state,
  );
  const stopEvents = translateAnthropicMessagesEventToOpenAIResponsesEvents({ type: 'content_block_stop', index: 0 } as AnthropicMessagesStreamEvent, state);

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

test('flattened namespace tool calls recover their source OpenAI Responses name', () => {
  const state = createAnthropicMessagesToOpenAIResponsesStreamState(
    'resp_test',
    'claude-test',
    new Set(),
    new Map([['web_run', { namespace: 'web', name: 'run' }]]),
  );

  translateAnthropicMessagesEventToOpenAIResponsesEvents(
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_web', name: 'web_run', input: {} } } as AnthropicMessagesStreamEvent,
    state,
  );
  translateAnthropicMessagesEventToOpenAIResponsesEvents(
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"search_query":[]}' } } as AnthropicMessagesStreamEvent,
    state,
  );
  translateAnthropicMessagesEventToOpenAIResponsesEvents(
    { type: 'content_block_stop', index: 0 } as AnthropicMessagesStreamEvent,
    state,
  );

  const [item] = state.completedItems;
  assertEquals(item.type, 'function_call');
  if (item.type !== 'function_call') throw new Error('expected function_call');
  assertEquals(item.namespace, 'web');
  assertEquals(item.name, 'run');
  assertEquals(item.arguments, '{"search_query":[]}');
});

// ── speed / service_tier pass-through ──

test('Anthropic speed:fast maps to service_tier:fast on the OpenAI Responses result', () => {
  const result = runToCompletion({ input_tokens: 10, output_tokens: 5 }, { speed: 'fast' });

  assertEquals(result.service_tier, 'fast');
});

test('Anthropic service_tier:standard with no speed passes service_tier:standard through', () => {
  const result = runToCompletion({ input_tokens: 10, output_tokens: 5 }, { service_tier: 'standard' });

  assertEquals(result.service_tier, 'standard');
});

test('Anthropic service_tier absent results in no service_tier on the OpenAI Responses result', () => {
  const result = runToCompletion({ input_tokens: 10, output_tokens: 5 });

  assertEquals(result.service_tier, undefined);
});

test('Anthropic Messages message_start service_tier survives when message_delta omits it', () => {
  const result = runToCompletion({ input_tokens: 10, output_tokens: 5, service_tier: 'priority' });
  assertEquals(result.service_tier, 'priority');
});

test('Anthropic Messages message_start speed:fast survives when message_delta omits it', () => {
  const result = runToCompletion({ input_tokens: 10, output_tokens: 5, speed: 'fast' });
  assertEquals(result.service_tier, 'fast');
});

test('Anthropic Messages delta atomically replaces tier and merges late cache accounting into OpenAI Responses', () => {
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
  });
});

test.each([
  ['cyber', 'cyber_policy', 'Cyber refusal.'],
  ['bio', 'bio_policy', 'This content was flagged for possible biological risk. Bio refusal.'],
  ['frontier_llm', 'invalid_prompt', 'Frontier refusal.'],
  ['future_policy', 'invalid_prompt', 'Future refusal.'],
] as const)('Anthropic Messages %s refusal becomes a failed Codex OpenAI Responses policy result', (category, code, message) => {
  const state = createAnthropicMessagesToOpenAIResponsesStreamState('resp_refusal', 'claude-opus-5');
  translateAnthropicMessagesEventToOpenAIResponsesEvents({
    type: 'message_start',
    message: {
      id: 'msg_refusal',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-opus-5',
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  }, state);
  translateAnthropicMessagesEventToOpenAIResponsesEvents({
    type: 'message_delta',
    delta: {
      stop_reason: 'refusal',
      stop_details: {
        type: 'refusal',
        category,
        explanation: category === 'bio' ? 'Bio refusal.' : `${category === 'cyber' ? 'Cyber' : category === 'frontier_llm' ? 'Frontier' : 'Future'} refusal.`,
      },
    },
    usage: { output_tokens: 0 },
  }, state);

  const result = translateAnthropicMessagesEventToOpenAIResponsesEvents({ type: 'message_stop' }, state);
  const failed = result.find((event): event is Extract<OpenAIResponsesStreamEvent, { type: 'response.failed' }> => event.type === 'response.failed');
  assertEquals(failed?.response.status, 'failed');
  assertEquals(failed?.response.error, { code, message });
  assertEquals(failed?.response.output, []);
});

test('Anthropic Messages fallback block changes the OpenAI Responses serving model without becoming output', () => {
  const state = createAnthropicMessagesToOpenAIResponsesStreamState('resp_fallback', 'claude-opus-5');
  translateAnthropicMessagesEventToOpenAIResponsesEvents({
    type: 'message_start',
    message: {
      id: 'msg_fallback',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-opus-5',
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  }, state);
  const boundary = translateAnthropicMessagesEventToOpenAIResponsesEvents({
    type: 'content_block_start',
    index: 0,
    content_block: {
      type: 'fallback',
      from: { model: 'claude-opus-5' },
      to: { model: 'claude-opus-4-8' },
      trigger: { type: 'refusal', category: 'cyber' },
    },
  }, state);
  translateAnthropicMessagesEventToOpenAIResponsesEvents({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, state);
  const result = translateAnthropicMessagesEventToOpenAIResponsesEvents({ type: 'message_stop' }, state);
  const completed = result.find((event): event is Extract<OpenAIResponsesStreamEvent, { type: 'response.completed' }> => event.type === 'response.completed');

  assertEquals(boundary, []);
  assertEquals(completed?.response.model, 'claude-opus-4-8');
  assertEquals(completed?.response.output, []);
});

test('an upstream ping is consumed without emitting a OpenAI Responses event or advancing the sequence', () => {
  const state = createAnthropicMessagesToOpenAIResponsesStreamState('resp_test', 'claude-test');

  const before = translateAnthropicMessagesEventToOpenAIResponsesEvents(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    } as AnthropicMessagesStreamEvent,
    state,
  );
  const lastBefore = before.at(-1)?.sequence_number;
  if (typeof lastBefore !== 'number') throw new Error('expected the preceding event to carry a sequence_number');

  assertEquals(translateAnthropicMessagesEventToOpenAIResponsesEvents({ type: 'ping' } as AnthropicMessagesStreamEvent, state), []);

  const after = translateAnthropicMessagesEventToOpenAIResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'hi' },
    } as AnthropicMessagesStreamEvent,
    state,
  );

  assertEquals(after[0]?.sequence_number, lastBefore + 1);
});
