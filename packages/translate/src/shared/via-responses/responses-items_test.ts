import { test } from 'vitest';

import { chatCompletionsViaResponsesItemsView, canonicalizeResponsesPayload, geminiViaResponsesItemsView, messagesViaResponsesItemsView, responsesItemsView } from './responses-items.ts';
import { assertEquals, assertThrows } from '../../test-assert.ts';
import { TranslatorInputError } from '../../translator-input-error.ts';
import { packReasoningSignature } from '../messages-and-responses/reasoning.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { GeminiPayload } from '@floway-dev/protocols/gemini';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ResponsesInputItem, ResponsesPayload } from '@floway-dev/protocols/responses';

test('canonicalizes string and implicit-message wire inputs', () => {
  assertEquals(canonicalizeResponsesPayload({ model: 'gpt-test', input: 'hello' }), {
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'hello' }],
  });

  assertEquals(canonicalizeResponsesPayload({
    model: 'gpt-test',
    input: [
      { role: 'system', content: 'rules', phase: 'future_phase' },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'look', prompt_cache_breakpoint: { mode: 'future_mode' } },
          { type: 'input_image', file_id: 'file_1', detail: 'original', prompt_cache_breakpoint: { mode: 'explicit' } },
          { type: 'input_file', file_id: 'file_2', prompt_cache_breakpoint: { mode: 'explicit' } },
        ],
      },
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'function_call_output', call_id: 'call_1', output: 'result' },
    ],
  }), {
    model: 'gpt-test',
    input: [
      { type: 'message', role: 'system', content: 'rules', phase: 'future_phase' },
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'look', prompt_cache_breakpoint: { mode: 'future_mode' } },
          { type: 'input_image', file_id: 'file_1', detail: 'original', prompt_cache_breakpoint: { mode: 'explicit' } },
          { type: 'input_file', file_id: 'file_2', prompt_cache_breakpoint: { mode: 'explicit' } },
        ],
      },
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'function_call_output', call_id: 'call_1', output: 'result' },
    ],
  });
});

test('rejects malformed untyped input items at the canonical boundary', () => {
  for (const malformed of [
    null,
    42,
    { content: 'missing role' },
    { role: 'unknown', content: 'invalid role' },
    { role: 'user', content: [null] },
    { role: 'user', content: [{}] },
    { role: 'user', content: [{ type: 'input_text' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'invalid breakpoint', prompt_cache_breakpoint: {} }] },
    { role: 'user', content: 'invalid phase', phase: 42 },
  ]) {
    const error = assertThrows(
      () => canonicalizeResponsesPayload({
        model: 'gpt-test',
        input: [malformed] as unknown as ResponsesPayload['input'],
      }),
      TranslatorInputError,
      'valid role and content',
    ) as TranslatorInputError;
    assertEquals(error.param, 'input[0]');
  }
});

test('mapAsResponsesItems maps Responses input items through the callback', async () => {
  const payload = canonicalizeResponsesPayload({
    model: 'gpt-test',
    input: [
      { type: 'item_reference', id: 'msg_stored' },
      { type: 'reasoning', id: 'rs_stored', summary: [{ type: 'summary_text', text: 'trace' }] },
      { type: 'function_call', call_id: 'call_stored', name: 'lookup', arguments: '{}', status: 'completed' },
    ],
  });

  const mapped = await responsesItemsView.mapAsResponsesItems(payload.input, item => {
    if (item.type === 'item_reference') return { type: 'message', role: 'user', content: 'expanded' };
    if (item.type === 'reasoning') return { ...item, id: 'rs_next' };
    if (item.type === 'function_call') return null;
    return item;
  });

  assertEquals(mapped, [
    { type: 'message', role: 'user', content: 'expanded' },
    { type: 'reasoning', id: 'rs_next', summary: [{ type: 'summary_text', text: 'trace' }] },
  ]);
  assertEquals(payload.input[0], { type: 'item_reference', id: 'msg_stored' });
});

test('mapAsResponsesItems maps only Messages thinking blocks with gateway reasoning signatures', async () => {
  const payload: MessagesPayload = {
    model: 'claude-test',
    max_tokens: 256,
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'trace', signature: packReasoningSignature('rs_stored', '') },
          { type: 'thinking', thinking: 'ordinary', signature: 'provider-signature' },
          { type: 'text', text: 'visible' },
        ],
      },
    ],
  };

  const mapped = await messagesViaResponsesItemsView.mapAsResponsesItems(payload.messages, item => {
    if (item.type !== 'reasoning') return item;
    return { ...item, id: 'rs_next', summary: [{ type: 'summary_text', text: 'rewritten' }] };
  });

  assertEquals(mapped, [
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'rewritten', signature: packReasoningSignature('rs_next', '') },
        { type: 'thinking', thinking: 'ordinary', signature: 'provider-signature' },
        { type: 'text', text: 'visible' },
      ],
    },
  ]);
  assertEquals(payload.messages[0], {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'trace', signature: packReasoningSignature('rs_stored', '') },
      { type: 'thinking', thinking: 'ordinary', signature: 'provider-signature' },
      { type: 'text', text: 'visible' },
    ],
  });
});

test('visitAsResponsesItems scans Messages carriers without rebuilding source messages', async () => {
  const messages: MessagesPayload['messages'] = [
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'trace', signature: packReasoningSignature('rs_stored', '') },
        { type: 'thinking', thinking: 'ordinary', signature: 'provider-signature' },
        { type: 'text', text: 'visible' },
      ],
    },
  ];
  const visited: ResponsesInputItem[] = [];

  const result = await messagesViaResponsesItemsView.visitAsResponsesItems(messages, item => {
    visited.push(item);
  });

  assertEquals(result, undefined);
  assertEquals(visited, [
    { type: 'reasoning', id: 'rs_stored', summary: [{ type: 'summary_text', text: 'trace' }] },
  ]);
  assertEquals(messages[0], {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'trace', signature: packReasoningSignature('rs_stored', '') },
      { type: 'thinking', thinking: 'ordinary', signature: 'provider-signature' },
      { type: 'text', text: 'visible' },
    ],
  });
});

test('mapAsResponsesItems can drop carried Messages reasoning without touching other content', async () => {
  const messages: MessagesPayload['messages'] = [
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'trace', signature: packReasoningSignature('rs_stored', '') },
        { type: 'text', text: 'visible' },
      ],
    },
  ];

  const mapped = await messagesViaResponsesItemsView.mapAsResponsesItems(messages, item => (item.type === 'reasoning' ? null : item));

  assertEquals(mapped, [
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'visible' }],
    },
  ]);
});

test('mapAsResponsesItems maps Chat reasoning_items and leaves non-carriers unchanged', async () => {
  const payload: ChatCompletionsPayload = {
    model: 'gpt-test',
    messages: [
      { role: 'system', content: 'keep system' },
      {
        role: 'assistant',
        content: null,
        reasoning_items: [{ type: 'reasoning', id: 'rs_stored', summary: [{ type: 'summary_text', text: 'trace' }] }],
        tool_calls: [{ id: 'call_stored', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_stored', content: '42' },
    ],
  };

  const mapped = await chatCompletionsViaResponsesItemsView.mapAsResponsesItems(payload.messages, item => {
    if (item.type !== 'reasoning') return item;
    return { ...item, id: 'rs_next', summary: [{ type: 'summary_text', text: 'next' }] };
  });

  assertEquals(mapped, [
    { role: 'system', content: 'keep system' },
    {
      role: 'assistant',
      content: null,
      reasoning_items: [
        { type: 'reasoning', id: 'rs_next', summary: [{ type: 'summary_text', text: 'next' }] },
      ],
      tool_calls: [{ id: 'call_stored', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call_stored', content: '42' },
  ]);
});

test('mapAsResponsesItems does not treat Gemini thought signatures as Responses carriers', async () => {
  const payload: GeminiPayload = {
    contents: [
      {
        role: 'model',
        parts: [
          { text: 'trace', thought: true, thoughtSignature: packReasoningSignature('rs_not_supported', '') },
          { functionCall: { id: 'call_stored', name: 'lookup', args: { q: 'x' } } },
        ],
      },
    ],
  };

  let calls = 0;
  const mapped = await geminiViaResponsesItemsView.mapAsResponsesItems(payload.contents!, item => {
    calls += 1;
    return item;
  });

  assertEquals(calls, 0);
  assertEquals(mapped, payload.contents);
  assertEquals(mapped === payload.contents, false);
});

test('canonicalizeResponsesPayload preserves reasoning.context verbatim, including future modes', () => {
  const canonicalCurrent = canonicalizeResponsesPayload({
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    reasoning: { effort: 'high', context: 'current_turn' },
  });
  assertEquals(canonicalCurrent.reasoning, { effort: 'high', context: 'current_turn' });

  // An unknown/future context string rides through the wire→canonical boundary
  // untouched — the upstream owns the accept/reject decision.
  const canonicalFuture = canonicalizeResponsesPayload({
    model: 'gpt-test',
    input: 'hi',
    reasoning: { context: 'future_mode' },
  });
  assertEquals(canonicalFuture.reasoning, { context: 'future_mode' });
});
