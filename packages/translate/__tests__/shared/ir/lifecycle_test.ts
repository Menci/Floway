import { expect, test, vi } from 'vitest';

import { collect, collectIR, events, iterate } from './helpers.ts';
import { nativeResult } from './translation-cases.ts';
import { irFromAnthropicMessages } from '../../../src/shared/ir/sse-from/anthropic-messages/index.ts';
import { irFromOpenAIChatCompletions } from '../../../src/shared/ir/sse-from/openai-chat-completions/index.ts';
import { irFromOpenAIResponses } from '../../../src/shared/ir/sse-from/openai-responses/index.ts';
import { anthropicMessagesFromIR } from '../../../src/shared/ir/sse-to/anthropic-messages/index.ts';
import { geminiGenerateContentFromIR } from '../../../src/shared/ir/sse-to/gemini-generatecontent/index.ts';
import { openaiChatCompletionsFromIR } from '../../../src/shared/ir/sse-to/openai-chat-completions/index.ts';
import { openaiResponsesFromIR } from '../../../src/shared/ir/sse-to/openai-responses/index.ts';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';

const chat = (delta: any, finish_reason: string | null = null) => eventFrame({ id: 'chatcmpl_lifecycle', model: 'served', created: 1, choices: [{ index: 0, delta, finish_reason }] } as any);
const tool = (index: number, arguments_: string, id?: string, name?: string) => chat({ tool_calls: [{ index, ...(id === undefined ? {} : { id }), type: 'function', function: { ...(name === undefined ? {} : { name }), arguments: arguments_ } }] });
const messageStart = eventFrame({ type: 'message_start', message: { id: 'msg_lifecycle', model: 'served', usage: { input_tokens: 1, output_tokens: 0 } } } as any);
const messageEnd = (stop_reason: string) => [eventFrame({ type: 'message_delta', delta: { stop_reason }, usage: { output_tokens: 2 } } as any), eventFrame({ type: 'message_stop' } as any)];

const gated = async <T>(prefix: T[], suffix: T[], convert: (source: AsyncIterable<T>) => AsyncIterable<any>, check: (frames: any[]) => void) => {
  let reached!: () => void;
  let release!: () => void;
  const atGate = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const source = async function* () { yield* prefix; reached(); await gate; yield* suffix; };
  const frames: any[] = [];
  const run = (async () => { for await (const frame of convert(source())) frames.push(frame); })();
  await Promise.race([atGate, run.then(() => { throw new Error('Converter ended before the upstream checkpoint'); })]);
  try { check(frames); } finally { release(); }
  await run;
  return frames;
};

test('ChatCompletions emits scalar reasoning before the next upstream frame and ignores carriers', async () => {
  const frames = await gated([chat({ reasoning_text: 'live' })], [chat({ content: 'body' }), chat({ reasoning_items: [{ id: 'poison', summary: [{ text: 'POISON' }] }] }), chat({}, 'stop'), doneFrame()], irFromOpenAIChatCompletions, output => {
    expect(output.flatMap(frame => frame.records)).toContainEqual(expect.objectContaining({ type: 'operation', operation: 'append', value: 'live' }));
  });
  const ir = await collectIR(iterate(frames));
  expect(ir.choices[0].items).toEqual([{ type: 'reasoning', summary: ['live'] }, { type: 'message', content: [{ type: 'text', text: 'body' }] }]);
  expect(JSON.stringify(ir)).not.toContain('poison');
});

test('ChatCompletions creates separate reasoning runs at every text interruption', async () => {
  const ir = await collectIR(irFromOpenAIChatCompletions(iterate([chat({ reasoning_text: 'r1' }), chat({ content: 'body' }), chat({ reasoning_text: 'r2' }), chat({ content: 'tail' }), chat({}, 'stop'), doneFrame()])));
  expect(ir.choices[0].items).toEqual([{ type: 'reasoning', summary: ['r1'] }, { type: 'message', content: [{ type: 'text', text: 'body' }] }, { type: 'reasoning', summary: ['r2'] }, { type: 'message', content: [{ type: 'text', text: 'tail' }] }]);
});

test('an old open tool update leaves the current ChatCompletions text run open', async () => {
  const ir = await collectIR(irFromOpenAIChatCompletions(iterate([chat({ content: 'before' }), tool(0, '{"x":', 'call', 'lookup'), chat({ content: 'middle' }), tool(0, '1}'), chat({ content: 'after' }), chat({}, 'tool_calls'), doneFrame()])));
  expect(ir.choices[0].items).toEqual([{ type: 'message', content: [{ type: 'text', text: 'before' }] }, { type: 'function_call', name: 'lookup', call_id: 'call', arguments: '{"x":1}' }, { type: 'message', content: [{ type: 'text', text: 'middleafter' }] }]);
});

test('object completion closes a tool once and ignores subsequent data with a warning', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const frames = await gated([tool(0, '{"value":"}\\\"{"}', 'call', 'lookup')], [tool(0, 'BAD'), chat({}, 'tool_calls'), doneFrame()], irFromOpenAIChatCompletions, output => {
      expect(output.flatMap(frame => frame.records).filter((record: any) => record.type === 'item_end')).toEqual([{ type: 'item_end', choice: 0, item: 0, status: 'completed' }]);
    });
    expect(warning).toHaveBeenCalledTimes(1);
    const ir = await collectIR(iterate(frames));
    expect(ir.choices[0].items[0]).toMatchObject({ arguments: '{"value":"}\\\"{"}' });
  } finally { warning.mockRestore(); }
});

test.each([['Responses', openaiResponsesFromIR], ['Messages', anthropicMessagesFromIR]] as const)('%s waits for the actual tool identity before publishing its start', async (name, writer) => {
  const frames = await gated([tool(0, '{"x":', undefined, 'lookup')], [tool(0, '1}', 'call_real'), chat({}, 'tool_calls'), doneFrame()], source => writer(irFromOpenAIChatCompletions(source)), output => {
    expect(output.some((frame: any) => frame.event?.type === 'response.output_item.added' || frame.event?.type === 'content_block_start')).toBe(false);
  });
  const result: any = await nativeResult(name === 'Responses' ? 'openai-responses' : 'anthropic-messages', frames);
  expect(name === 'Responses' ? result.output[0].call_id : result.content[0].id).toBe('call_real');
});

const response = (output: any[], status = 'completed') => ({ id: 'resp_lifecycle', model: 'served', status, output, usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 }, error: null, incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null });
const responseStart = eventFrame({ type: 'response.created', response: response([], 'in_progress') } as any);
const add = (index: number, item: any) => eventFrame({ type: 'response.output_item.added', output_index: index, item } as any);
const call = (index: number, arguments_ = '', status = 'in_progress') => ({ type: 'function_call', id: `fc_${index}`, call_id: `call_${index}`, name: `tool${index}`, arguments: arguments_, status });
const args = (index: number, delta: string) => eventFrame({ type: 'response.function_call_arguments.delta', output_index: index, delta } as any);
const endCall = (index: number, arguments_: string, status = 'completed') => eventFrame({ type: 'response.output_item.done', output_index: index, item: call(index, arguments_, status) } as any);

test.each([['ChatCompletions', openaiChatCompletionsFromIR], ['Messages', anthropicMessagesFromIR]] as const)('%s streams the second tool while the first remains open', async (name, writer) => {
  await gated([responseStart, add(0, call(0)), args(0, '{"x":'), add(1, call(1)), args(1, '{"y":2}'), endCall(1, '{"y":2}')], [args(0, '1}'), endCall(0, '{"x":1}'), eventFrame({ type: 'response.completed', response: response([call(0, '{"x":1}', 'completed'), call(1, '{"y":2}', 'completed')]) } as any)], source => writer(irFromOpenAIResponses(source)), output => {
    expect(output.some((frame: any) => name === 'Messages' ? frame.event?.type === 'content_block_stop' && frame.event.index === 1 : frame.event?.choices?.some((choice: any) => choice.delta.tool_calls?.some((tool: any) => tool.index === 1 && tool.function.arguments === '{"y":2}')))).toBe(true);
  });
});

test.each([['ChatCompletions', openaiChatCompletionsFromIR], ['Messages', anthropicMessagesFromIR], ['GenerateContent', geminiGenerateContentFromIR]] as const)('%s flattens reasoning content and summary in arrival order', async (name, writer) => {
  const item = { type: 'reasoning', id: 'r', summary: [] };
  const source = [responseStart, add(0, item), eventFrame({ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'reasoning_text', text: '' } } as any), eventFrame({ type: 'response.reasoning_text.delta', output_index: 0, content_index: 0, delta: 'C' } as any), eventFrame({ type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } } as any), eventFrame({ type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'S' } as any), eventFrame({ type: 'response.completed', response: response([{ ...item, content: [{ type: 'reasoning_text', text: 'C' }], summary: [{ type: 'summary_text', text: 'S' }] }]) } as any)];
  const frames: any[] = await collect<any>(writer(irFromOpenAIResponses(iterate(source))));
  const text = frames.map(frame => name === 'ChatCompletions' ? frame.event?.choices?.[0]?.delta.reasoning_text ?? '' : name === 'Messages' ? frame.event.delta?.thinking ?? '' : frame.event.candidates?.[0]?.content?.parts?.filter((part: any) => part.thought).map((part: any) => part.text).join('') ?? '').join('');
  expect(text).toBe('CS');
});

test('GenerateContent preserves completed tool order when the second finishes first', async () => {
  const frames = await gated([responseStart, add(0, call(0)), args(0, '{"x":'), add(1, call(1)), args(1, '{}'), endCall(1, '{}')], [args(0, '1}'), endCall(0, '{"x":1}'), eventFrame({ type: 'response.completed', response: response([call(0, '{"x":1}', 'completed'), call(1, '{}', 'completed')]) } as any)], source => geminiGenerateContentFromIR(irFromOpenAIResponses(source)), output => {
    expect(output).toEqual([]);
  });
  expect(frames.flatMap((frame: any) => frame.event.candidates?.flatMap((candidate: any) => candidate.content?.parts ?? []) ?? []).filter((part: any) => part.functionCall).map((part: any) => part.functionCall.id)).toEqual(['call_0', 'call_1']);
});

test.each([['ChatCompletions', openaiChatCompletionsFromIR], ['Responses', openaiResponsesFromIR], ['GenerateContent', geminiGenerateContentFromIR]] as const)('%s preserves Messages token cutoff without parsing incomplete input', async (name, writer) => {
  const source = [messageStart, eventFrame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call', name: 'lookup', input: {} } } as any), eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"x":' } } as any), eventFrame({ type: 'content_block_stop', index: 0 } as any), ...messageEnd('max_tokens')];
  const frames: any[] = await collect<any>(writer(irFromAnthropicMessages(iterate(source))));
  if (name === 'ChatCompletions') {
    expect(frames.some(frame => frame.event?.choices?.[0]?.finish_reason === 'length')).toBe(true);
    expect(frames.flatMap(frame => frame.event?.choices?.[0]?.delta.tool_calls ?? []).map(tool => tool.function.arguments ?? '').join('')).toBe('{"x":');
  } else if (name === 'Responses') {
    expect(frames.at(-1).event).toMatchObject({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' }, output: [{ arguments: '{"x":', status: 'incomplete' }] } });
  } else {
    expect(frames.flatMap(frame => frame.event.candidates?.flatMap((candidate: any) => candidate.content?.parts ?? []) ?? [])).toEqual([]);
    expect(frames.at(-1).event.candidates[0].finishReason).toBe('MAX_TOKENS');
  }
});

test('ChatCompletions opaque selects the first reasoning group final signature even if another closes first', async () => {
  const source = [messageStart, eventFrame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } as any), eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'first' } } as any), eventFrame({ type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'SECOND' } } as any), eventFrame({ type: 'content_block_stop', index: 1 } as any), eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'FIRST' } } as any), eventFrame({ type: 'content_block_stop', index: 0 } as any), ...messageEnd('end_turn')];
  const output = await collect(events(openaiChatCompletionsFromIR(irFromAnthropicMessages(iterate(source)))));
  expect(output.flatMap(chunk => chunk.choices?.flatMap(choice => (choice.delta as any).reasoning_opaque === undefined ? [] : [(choice.delta as any).reasoning_opaque]) ?? [])).toEqual(['FIRST']);
});

test('empty ChatCompletions scalar deltas do not interrupt reasoning', async () => {
  const ir = await collectIR(irFromOpenAIChatCompletions(iterate([chat({ role: 'assistant', content: '' }), chat({ reasoning_text: 'r1' }), chat({ content: '' }), chat({ reasoning_text: 'r2' }), chat({}, 'stop'), doneFrame()])));
  expect(ir.choices[0].items).toEqual([{ type: 'reasoning', summary: ['r1r2'] }]);
});

test('Responses closes only the addressed part while another part remains open', async () => {
  const prefix: any[] = [{ records: [{ type: 'start', id: 'resp_parts', model: 'served' }, { type: 'operation', operation: 'assign', path: ['choices'], value: [{ items: [{ type: 'message', content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] }] }] }, { type: 'part_end', choice: 0, item: 0, part: 0 }] }];
  const suffix: any[] = [{ records: [{ type: 'operation', operation: 'append', path: ['choices', 0, 'items', 0, 'content', 1, 'text'], value: 'C' }, { type: 'part_end', choice: 0, item: 0, part: 1 }, { type: 'item_end', choice: 0, item: 0 }, { type: 'choice_end', choice: 0, finish_reason: 'stop' }, { type: 'finish', status: 'completed' }] }];
  const frames = await gated(prefix, suffix, openaiResponsesFromIR, output => {
    expect(output.filter(frame => frame.event.type === 'response.content_part.done').map(frame => frame.event.content_index)).toEqual([0]);
  });
  const result: any = await nativeResult('openai-responses', frames);
  expect(result.output[0].content.map((part: any) => part.text)).toEqual(['A', 'BC']);
});

test('GenerateContent retains reasoning arrival order while it waits for a prior tool', async () => {
  const reasoning = { type: 'reasoning', id: 'r', content: [{ type: 'reasoning_text', text: 'C' }], summary: [] };
  const source = [responseStart, add(0, call(0)), args(0, '{"x":'), add(1, reasoning), eventFrame({ type: 'response.reasoning_summary_part.added', output_index: 1, summary_index: 0, part: { type: 'summary_text', text: 'S' } } as any), eventFrame({ type: 'response.output_item.done', output_index: 1, item: { ...reasoning, summary: [{ type: 'summary_text', text: 'S' }] } } as any), args(0, '1}'), endCall(0, '{"x":1}'), eventFrame({ type: 'response.completed', response: response([call(0, '{"x":1}', 'completed'), { ...reasoning, summary: [{ type: 'summary_text', text: 'S' }] }]) } as any)];
  const frames = await collect(geminiGenerateContentFromIR(irFromOpenAIResponses(iterate(source))));
  const parts = frames.flatMap(frame => (frame.event as any).candidates?.flatMap((candidate: any) => candidate.content?.parts ?? []) ?? []);
  expect(parts[0].functionCall.id).toBe('call_0');
  expect(parts.filter((part: any) => part.thought).map((part: any) => part.text).join('')).toBe('CS');
});
