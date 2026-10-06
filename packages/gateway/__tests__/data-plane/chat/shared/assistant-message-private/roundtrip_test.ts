import { expect, test } from 'vitest';

import { assertChatUpstreamRoundtrip, assertChatViaMessagesRoundtrip, assertChatViaResponsesRoundtrip, assertResponsesIntervalsRoundtrip, assertGeminiIntervalsRoundtrip } from './roundtrip.ts';
import { createAnthropicMessagesUsage, toAnthropicMessagesUsageDelta, type AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsAssistantDeltaEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesStreamEventEx, OpenAIResponsesOutputItemEx } from '@floway-dev/protocols/openai-responses';

const chat = (delta: OpenAIChatCompletionsAssistantDeltaEx, finish_reason: 'stop' | 'tool_calls' | null = null) => eventFrame({ id: 'chat', object: 'chat.completion.chunk', model: 'm', created: 1, choices: [{ index: 0, delta, finish_reason }] } as OpenAIChatCompletionsStreamEvent);

const responseFrames = (events: readonly OpenAIResponsesStreamEventEx[]) => events.map((event, sequence_number) => eventFrame({ ...event, sequence_number }));
const responseItemStart = (output_index: number, item: OpenAIResponsesOutputItemEx): OpenAIResponsesStreamEventEx[] => {
  if (item.type === 'message') return [
    { type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress', content: [] } },
    ...item.content.map((part, content_index) => ({ type: 'response.content_part.added' as const, output_index, content_index, item_id: item.id!, part: part.type === 'output_text' ? { ...part, text: '' } : part })),
  ];
  if (item.type === 'reasoning') return [
    { type: 'response.output_item.added', output_index, item: { ...item, summary: [], content: [] } },
    ...item.summary.map((part, summary_index) => ({ type: 'response.reasoning_summary_part.added' as const, output_index, summary_index, item_id: item.id!, part: { ...part, text: '' } })),
    ...(item.content ?? []).map((part, content_index) => ({ type: 'response.content_part.added' as const, output_index, content_index, item_id: item.id!, part: { ...part, text: '' } })),
  ];
  return [{ type: 'response.output_item.added', output_index, item }];
};
const responseItemDone = (output_index: number, item: OpenAIResponsesOutputItemEx): OpenAIResponsesStreamEventEx[] => {
  const events: OpenAIResponsesStreamEventEx[] = [];
  if (item.type === 'message' || item.type === 'reasoning') {
    for (const [content_index, part] of (item.content ?? []).entries()) {
      if (part.type === 'output_text' || part.type === 'reasoning_text') events.push({ type: part.type === 'output_text' ? 'response.output_text.done' : 'response.reasoning_text.done', output_index, content_index, item_id: item.id!, text: part.text });
      events.push({ type: 'response.content_part.done', output_index, content_index, item_id: item.id!, part });
    }
    if (item.type === 'reasoning') for (const [summary_index, part] of item.summary.entries()) events.push(
      { type: 'response.reasoning_summary_text.done', output_index, summary_index, item_id: item.id!, text: part.text },
      { type: 'response.reasoning_summary_part.done', output_index, summary_index, item_id: item.id!, part },
    );
  } else if (item.type === 'function_call') events.push({ type: 'response.function_call_arguments.done', output_index, item_id: item.id!, arguments: item.arguments });
  events.push({ type: 'response.output_item.done', output_index, item });
  return events;
};
const messageDone: AnthropicMessagesStreamEventEx = { type: 'message_delta', delta: { container: null, stop_details: null, stop_sequence: null, stop_reason: 'end_turn' }, usage: toAnthropicMessagesUsageDelta(createAnthropicMessagesUsage(1, 2)) };

test.each(['anthropicMessages', 'openaiResponses', 'geminiGenerateContent'] as const)('%s via Chat compares replay with direct collection for reasoning/text/tools and late metadata', async protocol => {
  await assertChatUpstreamRoundtrip(protocol, [
    chat({ role: 'assistant', reasoning_content: 'A', reasoning_opaque: 'cipher', provider_specific_fields: { trace: 1 } }),
    chat({ tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'first', arguments: '{"a":' } }] }),
    chat({ content: 'answer' }),
    chat({ reasoning_content: 'B', tool_calls: [{ index: 1, id: 'b', type: 'function', function: { name: 'second', arguments: '{"b":' } }] }),
    chat({ tool_calls: [{ index: 0, function: { arguments: '1}' } }] }),
    chat({ tool_calls: [{ index: 1, function: { arguments: '2}' } }] }, 'tool_calls'),
    chat({ tool_calls: [{ index: 0, extra_content: { signature: 'late' } }] }), doneFrame(),
  ]);
});

test('Chat via Messages compares interleaved native thinking, text, tools, and opaque blocks with direct collection', async () => {
  const events: AnthropicMessagesStreamEventEx[] = [
    { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, stop_details: null, container: null, diagnostics: null, usage: createAnthropicMessagesUsage(1, 0) } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '', citations: null } },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '', citations: null } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'aa' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '\ud83d' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'bb' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'cc' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '\ude00' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'dd\ud800' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'c', name: 'client', caller: { type: 'direct' }, input: {} } },
    { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"q":1}' } },
    { type: 'content_block_start', index: 4, content_block: { type: 'server_tool_use', id: 's', name: 'web_search', input: {}, caller: { type: 'direct' } } },
    { type: 'content_block_delta', index: 4, delta: { type: 'input_json_delta', partial_json: '{"query":"docs"}' } },
    { type: 'content_block_start', index: 5, content_block: { type: 'redacted_thinking', data: 'redacted' } },
    ...[3, 1, 4, 2, 0, 5].map(index => ({ type: 'content_block_stop' as const, index })),
    { type: 'message_delta', delta: { container: null, stop_details: null, stop_sequence: null, stop_reason: 'tool_use' }, usage: toAnthropicMessagesUsageDelta(createAnthropicMessagesUsage(1, 2)) },
    { type: 'message_stop' },
  ];
  await assertChatViaMessagesRoundtrip(events.map(eventFrame), message => { for (const call of message.tool_calls!) if (call.type === 'function') call.function.name = 'edited'; });
});

test('Chat via Responses compares interleaved parts and native opaque items with direct collection', async () => {
  const text = (id: string, value: string): OpenAIResponsesOutputItemEx => ({ type: 'message', id, role: 'assistant', status: 'completed', phase: 'commentary', content: [{ type: 'output_text', text: value, annotations: [] }] });
  const call = { type: 'function_call', id: 'fc', call_id: 'f', name: 'original', arguments: '{"q":1}', status: 'completed' } as const;
  const native: OpenAIResponsesOutputItemEx[] = [text('a', 'aacc'), { type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text: 'AB' }], content: [{ type: 'reasoning_text', text: 'CD' }], encrypted_content: 'cipher' }, text('b', 'bbdd'), { type: 'custom_tool_call', id: 'ct', call_id: 'custom', name: 'raw', input: 'unprojected', status: 'completed' }, { type: 'compaction', id: 'cmp', encrypted_content: 'compact' }, call, { type: 'web_search_call', id: 'ws', status: 'completed', action: { type: 'search', query: 'docs' } }];
  const events: OpenAIResponsesStreamEventEx[] = [
    { type: 'response.created', response: { id: 'resp', object: 'response', model: 'm', status: 'in_progress', output: [], error: null, incomplete_details: null } },
    ...native.slice(0, 3).flatMap((item, index) => responseItemStart(index, item)),
    ...native.slice(3, 5).map((item, i) => ({ type: 'response.output_item.added' as const, output_index: i + 3, item })),
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'a', delta: 'aa' },
    { type: 'response.reasoning_summary_text.delta', output_index: 1, summary_index: 0, item_id: 'r', delta: 'A' },
    { type: 'response.output_text.delta', output_index: 2, content_index: 0, item_id: 'b', delta: 'bb' },
    { type: 'response.reasoning_text.delta', output_index: 1, content_index: 0, item_id: 'r', delta: 'C' },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'a', delta: 'cc' },
    { type: 'response.reasoning_summary_text.delta', output_index: 1, summary_index: 0, item_id: 'r', delta: 'B' },
    { type: 'response.output_text.delta', output_index: 2, content_index: 0, item_id: 'b', delta: 'dd' },
    { type: 'response.reasoning_text.delta', output_index: 1, content_index: 0, item_id: 'r', delta: 'D' },
    { type: 'response.output_item.added', output_index: 5, item: { ...call, arguments: '', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 6, item: native[6] },
    { type: 'response.function_call_arguments.delta', output_index: 5, item_id: 'fc', delta: '{"q":' },
    { type: 'response.function_call_arguments.delta', output_index: 5, item_id: 'fc', delta: '1}' },
    ...native.toReversed().flatMap((item, i) => responseItemDone(native.length - i - 1, item)),
    { type: 'response.completed', response: { id: 'resp', object: 'response', model: 'm', status: 'completed', output: native, error: null, incomplete_details: null } },
  ];
  await assertChatViaResponsesRoundtrip(responseFrames(events), message => { for (const call of message.tool_calls!) if (call.type === 'function') call.function.name = 'edited'; });
});

const legalInterleavings = function* <T>(groups: readonly (readonly T[])[]) {
  const pending = [{ values: [] as T[], positions: groups.map(() => 0) }];
  while (pending.length > 0) {
    const next = pending.pop()!;
    let complete = true;
    for (const [index, group] of groups.entries()) {
      if (next.positions[index] === group.length) continue;
      complete = false;
      pending.push({ values: [...next.values, group[next.positions[index]]], positions: next.positions.map((position, i) => position + (i === index ? 1 : 0)) });
    }
    if (complete) yield next.values;
  }
};

test.each(['anthropicMessages', 'openaiResponses', 'geminiGenerateContent'] as const)('%s via Chat compares every interleaving of reasoning, text, and tool fragments with the native collector', async protocol => {
  const groups = [
    [chat({ reasoning_content: 'A' }), chat({ reasoning_content: 'B' })],
    [chat({ content: 'left' }), chat({ content: 'right' })],
    [chat({ tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'f', arguments: '{"q":' } }] }), chat({ tool_calls: [{ index: 0, function: { arguments: '1}' } }] })],
  ];
  let count = 0;
  for (const order of legalInterleavings(groups)) {
    await assertChatUpstreamRoundtrip(protocol, [chat({ role: 'assistant', reasoning_opaque: 'cipher' }), ...order, chat({}, 'tool_calls'), doneFrame()]);
    count++;
  }
  expect(count).toBe(90);
});

test('Chat via Responses compares surrogate-interleaved text parts with the direct upstream collector', async () => {
  const item = (id: string, text: string): OpenAIResponsesOutputItemEx => ({ type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
  const native = [item('a', '😀'), item('b', 'x\ud800')];
  await assertChatViaResponsesRoundtrip(responseFrames([
    { type: 'response.created', response: { id: 'resp', object: 'response', model: 'm', status: 'in_progress', output: [], error: null, incomplete_details: null } },
    ...native.flatMap((value, index) => responseItemStart(index, value)),
    ...([[0, '\ud83d'], [1, 'x'], [0, '\ude00'], [1, '\ud800']] as const).map(([output_index, delta]) => ({ type: 'response.output_text.delta', item_id: output_index === 0 ? 'a' : 'b', output_index, content_index: 0, delta } as OpenAIResponsesStreamEventEx)),
    ...native.flatMap((value, output_index) => responseItemDone(output_index, value)),
    { type: 'response.completed', response: { id: 'resp', object: 'response', model: 'm', status: 'completed', output: native, error: null, incomplete_details: null } },
  ]));
});

test('Chat via Responses compares initial item/part text plus subsequent deltas with the upstream collector', async () => {
  const initial: OpenAIResponsesOutputItemEx = { type: 'message', id: 'm', role: 'assistant', status: 'in_progress', content: [{ type: 'output_text', text: 'pre', annotations: [] }] };
  const final: OpenAIResponsesOutputItemEx = { ...initial, status: 'completed', content: [{ type: 'output_text', text: 'prefix', annotations: [] }] };
  const reasoning: OpenAIResponsesOutputItemEx = { type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text: 'initial' }] };
  const finalReasoning: OpenAIResponsesOutputItemEx = { ...reasoning, summary: [{ type: 'summary_text', text: 'initial tail' }] };
  await assertChatViaResponsesRoundtrip(responseFrames([
    { type: 'response.created', response: { id: 'resp', object: 'response', model: 'm', status: 'in_progress', output: [], error: null, incomplete_details: null } },
    { type: 'response.output_item.added', output_index: 0, item: initial }, { type: 'response.output_item.added', output_index: 1, item: reasoning },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: 'm', part: initial.content[0] },
    { type: 'response.reasoning_summary_part.added', output_index: 1, summary_index: 0, item_id: 'r', part: reasoning.summary[0] },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'm', delta: 'fix' },
    { type: 'response.reasoning_summary_text.delta', output_index: 1, summary_index: 0, item_id: 'r', delta: ' tail' },
    ...responseItemDone(0, final), ...responseItemDone(1, finalReasoning),
    { type: 'response.completed', response: { id: 'resp', object: 'response', model: 'm', status: 'completed', output: [final, finalReasoning], error: null, incomplete_details: null } },
  ]));
});

test('Chat via Messages compares empty text and citation increments with direct collection', async () => {
  await assertChatViaMessagesRoundtrip([
    eventFrame({ type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, stop_details: null, container: null, diagnostics: null, usage: createAnthropicMessagesUsage(1, 0) } }),
    eventFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: [] } }),
    eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '' } }),
    eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation: { type: 'char_location', cited_text: 'quote', document_index: 0, document_title: null, start_char_index: 0, end_char_index: 5, file_id: null } } }),
    eventFrame({ type: 'content_block_stop', index: 0 }), eventFrame(messageDone), eventFrame({ type: 'message_stop' }),
  ]);
});

test('Chat via Messages compares interleaved surrogate thinking and lone text units with direct collection', async () => {
  await assertChatViaMessagesRoundtrip([
    eventFrame({ type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, stop_details: null, container: null, diagnostics: null, usage: createAnthropicMessagesUsage(1, 0) } }),
    ...[0, 1].map(index => eventFrame({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } } as AnthropicMessagesStreamEventEx)),
    ...([[0, '\ud83d'], [1, 'x'], [0, '\ude00']] as const).map(([index, thinking]) => eventFrame({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } } as AnthropicMessagesStreamEventEx)),
    ...[0, 1].map(index => eventFrame({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: `${index}` } } as AnthropicMessagesStreamEventEx)),
    eventFrame({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: '', citations: null } }),
    eventFrame({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: '\ud800' } }),
    ...[0, 1, 2].map(index => eventFrame({ type: 'content_block_stop', index } as AnthropicMessagesStreamEventEx)),
    eventFrame(messageDone), eventFrame({ type: 'message_stop' }),
  ]);
});

test('Chat via Responses compares every legal interleaving of multiple text and summary parts with direct collection', async () => {
  const message: OpenAIResponsesOutputItemEx = { type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ab', annotations: [] }, { type: 'output_text', text: 'cd', annotations: [] }] };
  const reasoning: OpenAIResponsesOutputItemEx = { type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text: 'AB' }, { type: 'summary_text', text: 'CD' }], encrypted_content: 'cipher' };
  const output = [message, reasoning];
  const groups: OpenAIResponsesStreamEventEx[][] = [
    ...['ab', 'cd'].map((value, content_index) => [...value].map(delta => ({ type: 'response.output_text.delta' as const, output_index: 0, content_index, item_id: 'm', delta }))),
    ...['AB', 'CD'].map((value, summary_index) => [...value].map(delta => ({ type: 'response.reasoning_summary_text.delta' as const, output_index: 1, summary_index, item_id: 'r', delta }))),
  ];
  let count = 0;
  for (const order of legalInterleavings(groups)) {
    await assertChatViaResponsesRoundtrip(responseFrames([
      { type: 'response.created', response: { id: 'resp', object: 'response', model: 'm', status: 'in_progress', output: [], error: null, incomplete_details: null } },
      { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
      { type: 'response.output_item.added', output_index: 1, item: { ...reasoning, summary: [] } },
      ...message.content.map((part, content_index) => ({ type: 'response.content_part.added', output_index: 0, content_index, item_id: 'm', part: { ...part, text: '' } } as OpenAIResponsesStreamEventEx)),
      ...reasoning.summary.map((part, summary_index) => ({ type: 'response.reasoning_summary_part.added', output_index: 1, summary_index, item_id: 'r', part: { ...part, text: '' } } as OpenAIResponsesStreamEventEx)),
      ...order,
      ...responseItemDone(1, reasoning), ...responseItemDone(0, message),
      { type: 'response.completed', response: { id: 'resp', object: 'response', model: 'm', status: 'completed', output, error: null, incomplete_details: null } },
    ]));
    count++;
  }
  expect(count).toBe(2520);
});

test('Chat via Messages compares every interleaving of two thinking and two text blocks with direct collection', async () => {
  const groups: AnthropicMessagesStreamEventEx[][] = [
    ...['ab', 'cd'].map((value, index) => [...value].map(text => ({ type: 'content_block_delta' as const, index, delta: { type: 'text_delta' as const, text } }))),
    ...['AB', 'CD'].map((value, i) => [...value].map(thinking => ({ type: 'content_block_delta' as const, index: i + 2, delta: { type: 'thinking_delta' as const, thinking } }))),
  ];
  let count = 0;
  for (const order of legalInterleavings(groups)) {
    await assertChatViaMessagesRoundtrip([
      eventFrame({ type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, stop_details: null, container: null, diagnostics: null, usage: createAnthropicMessagesUsage(1, 0) } }),
      ...[0, 1].map(index => eventFrame({ type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: null } } as AnthropicMessagesStreamEventEx)),
      ...[2, 3].map(index => eventFrame({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } } as AnthropicMessagesStreamEventEx)),
      ...order.map(eventFrame),
      ...[2, 3].map(index => eventFrame({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: `${index}` } } as AnthropicMessagesStreamEventEx)),
      ...[3, 0, 2, 1].map(index => eventFrame({ type: 'content_block_stop', index } as AnthropicMessagesStreamEventEx)),
      eventFrame(messageDone), eventFrame({ type: 'message_stop' }),
    ]);
    count++;
  }
  expect(count).toBe(2520);
});

test.each(['anthropicMessages', 'openaiResponses', 'geminiGenerateContent'] as const)('%s via Chat compares plain text and unsigned reasoning with direct collection', async protocol => {
  await assertChatUpstreamRoundtrip(protocol, [chat({ role: 'assistant', content: 'plain' }), chat({}, 'stop'), doneFrame()]);
  await assertChatUpstreamRoundtrip(protocol, [chat({ role: 'assistant', content: '' }), chat({}, 'stop'), doneFrame()]);
  await assertChatUpstreamRoundtrip(protocol, [chat({ role: 'assistant', reasoning: '' }), chat({}, 'stop'), doneFrame()]);
  await assertChatUpstreamRoundtrip(protocol, [chat({ role: 'assistant', reasoning: 'only' }), chat({}, 'stop'), doneFrame()]);
  await assertChatUpstreamRoundtrip(protocol, [chat({ role: 'assistant', reasoning: 'A' }), chat({ content: 'answer' }), chat({ reasoning: 'B' }), chat({}, 'stop'), doneFrame()]);
});

test('Responses via Chat preserves separate adjacent assistant generations, including a plain generation', async () => {
  await assertResponsesIntervalsRoundtrip([
    [chat({ role: 'assistant', content: 'plain' }), chat({}, 'stop'), doneFrame()],
    [chat({ role: 'assistant', reasoning_content: 'A' }), chat({ content: 'answer' }), chat({ reasoning_content: 'B', reasoning_opaque: 'cipher' }), chat({}, 'stop'), doneFrame()],
  ]);
});

test('GenerateContent via Chat preserves generation boundaries across collected, chunked, and merged client history', async () => {
  await assertGeminiIntervalsRoundtrip([
    [chat({ role: 'assistant', content: 'plain' }), chat({}, 'stop'), doneFrame()],
    [chat({ role: 'assistant', reasoning_content: 'A' }), chat({ content: 'answer' }), chat({ reasoning_content: 'B', reasoning_opaque: 'cipher' }), chat({}, 'stop'), doneFrame()],
    [chat({ role: 'assistant' }), chat({}, 'stop'), doneFrame()],
  ], contents => {
    for (const content of contents) for (const part of content.parts!) if (part.thought === true) part.text = 'edited display thought';
  });
});

test.each(['text', 'tool'] as const)('GenerateContent via Chat retains %s carried on the terminal signature Part', async kind => {
  await assertGeminiIntervalsRoundtrip([[
    chat({ role: 'assistant', reasoning_content: 'A' }),
    kind === 'text' ? chat({ content: 'answer' }) : chat({ tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'f', arguments: '{"q":1}' } }] }),
    chat({}, kind === 'text' ? 'stop' : 'tool_calls'), doneFrame(),
  ]], contents => {
    const parts = contents.flatMap(content => content.parts!);
    const carrier = parts.at(-1)!;
    const payload = parts.at(-2)!;
    payload.thoughtSignature = carrier.thoughtSignature;
    for (const content of contents) content.parts = content.parts!.filter(part => part !== carrier);
  });
});

test('Chat via Responses compares every interleaving of text and reasoning item lifecycles with direct collection', async () => {
  const message: OpenAIResponsesOutputItemEx = { type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ab', annotations: [] }] };
  const reasoning: OpenAIResponsesOutputItemEx = { type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text: 'AB' }], encrypted_content: 'cipher' };
  const textEvents: OpenAIResponsesStreamEventEx[] = [
    ...responseItemStart(0, message),
    ...[...'ab'].map(delta => ({ type: 'response.output_text.delta' as const, output_index: 0, content_index: 0, item_id: 'm', delta })),
    ...responseItemDone(0, message),
  ];
  const reasoningEvents: OpenAIResponsesStreamEventEx[] = [
    ...responseItemStart(1, reasoning),
    ...[...'AB'].map(delta => ({ type: 'response.reasoning_summary_text.delta' as const, output_index: 1, summary_index: 0, item_id: 'r', delta })),
    ...responseItemDone(1, reasoning),
  ];
  let count = 0;
  for (const order of legalInterleavings([textEvents.slice(1), reasoningEvents])) {
    await assertChatViaResponsesRoundtrip(responseFrames([
      { type: 'response.created', response: { id: 'resp', object: 'response', model: 'm', status: 'in_progress', output: [], error: null, incomplete_details: null } },
      textEvents[0], ...order,
      { type: 'response.completed', response: { id: 'resp', object: 'response', model: 'm', status: 'completed', output: [message, reasoning], error: null, incomplete_details: null } },
    ]));
    count++;
  }
  expect(count).toBe(1716);
});

test('Chat via Messages compares every interleaving of text and thinking block lifecycles with direct collection', async () => {
  const textEvents: AnthropicMessagesStreamEventEx[] = [
    ...[...'ab'].map(text => ({ type: 'content_block_delta' as const, index: 0, delta: { type: 'text_delta' as const, text } })),
    { type: 'content_block_stop', index: 0 },
  ];
  const thinkingEvents: AnthropicMessagesStreamEventEx[] = [
    { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '', signature: '' } },
    ...[...'AB'].map(thinking => ({ type: 'content_block_delta' as const, index: 1, delta: { type: 'thinking_delta' as const, thinking } })),
    { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_stop', index: 1 },
  ];
  let count = 0;
  for (const order of legalInterleavings([textEvents, thinkingEvents])) {
    await assertChatViaMessagesRoundtrip([
      eventFrame({ type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, stop_details: null, container: null, diagnostics: null, usage: createAnthropicMessagesUsage(1, 0) } }),
      eventFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: null } }),
      ...order.map(eventFrame), eventFrame(messageDone), eventFrame({ type: 'message_stop' }),
    ]);
    count++;
  }
  expect(count).toBe(56);
});
