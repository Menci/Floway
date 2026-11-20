import { expect, test, vi } from 'vitest';

import { nativeResult } from './fixtures.ts';
import { writeAnthropicMessagesEvents, writeGeminiGenerateContentEvents, readAnthropicMessagesEvents, readOpenAIChatCompletionsEvents, readOpenAIResponsesEvents, writeOpenAIChatCompletionsEvents, writeOpenAIResponsesEvents } from './helpers.ts';
import { IRAbsent } from '../../src/ir/output/absent.ts';
import type { IRRecord } from '../../src/ir/output/records.ts';
import { collectIR } from '../ir/output/helpers.ts';
import { collect, iterate } from '../shared/iterables.ts';
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

test('an old open tool update leaves the current ChatCompletions text run open', async () => {
  const ir = await collectIR(readOpenAIChatCompletionsEvents(iterate([chat({ content: 'before' }), tool(0, '{"x":', 'call', 'lookup'), chat({ content: 'middle' }), tool(0, '1}'), chat({ content: 'after' }), chat({}, 'tool_calls'), doneFrame()])));
  expect(ir.choices[0].items).toEqual([{ type: 'message', content: [{ type: 'text', text: 'before' }] }, { type: 'function_call', name: 'lookup', call_id: 'call', arguments: '{"x":1}' }, { type: 'message', content: [{ type: 'text', text: 'middleafter' }] }]);
});

test('a complete JSON prefix stays open and preserves following argument text', async () => {
  const frames = await gated([tool(0, '{"x":1}', 'call', 'lookup')], [tool(0, ',{"x":2}'), chat({}, 'tool_calls'), doneFrame()], readOpenAIChatCompletionsEvents, output => {
    expect(output.filter((record: any) => record.type === 'item_end')).toEqual([]);
  });
  const ir = await collectIR(iterate(frames));
  expect(ir.choices[0].items[0]).toMatchObject({ arguments: '{"x":1},{"x":2}' });
});

test('a new tool closes the preceding function and later updates warn without reopening it', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const frames = await gated([tool(0, '{"x":1}', 'call0', 'lookup'), tool(1, '{"y":', 'call1', 'lookup')], [tool(0, 'BAD'), tool(1, '2}'), chat({}, 'tool_calls'), doneFrame()], readOpenAIChatCompletionsEvents, output => {
      expect(output.filter((record: any) => record.type === 'item_end')).toEqual([{ type: 'item_end', choice: 0, item: 0, status: 'completed' }]);
    });
    expect(warning).toHaveBeenCalledTimes(1);
    const ir = await collectIR(iterate(frames));
    expect(ir.choices[0].items).toMatchObject([{ arguments: '{"x":1}' }, { arguments: '{"y":2}' }]);
  } finally { warning.mockRestore(); }
});

test('a wrapped custom input is published when its native function boundary closes', async () => {
  const frames = await gated([tool(0, '{"input":"text"}', 'call0', 'script'), tool(1, '{}', 'call1', 'lookup')], [chat({}, 'tool_calls'), doneFrame()], source => readOpenAIChatCompletionsEvents(source, { customToolNames: new Set(['script']) }), output => {
    expect(output).toContainEqual({ type: 'write', kind: 'append', path: ['choices', 0, 'items', 0, 'input'], value: 'text' });
    expect(output).toContainEqual({ type: 'item_end', choice: 0, item: 0, status: 'completed' });
  });
  expect((await collectIR(iterate(frames))).choices[0].items[0]).toMatchObject({ type: 'custom_tool_call', input: 'text' });
});

const irPrefix = (callId?: string | typeof IRAbsent): IRRecord[] => [
  { type: 'write', kind: 'initialize', path: ['choices', 0], value: { items: [] } },
  { type: 'write', kind: 'assign', path: ['model'], value: 'served' },
  { type: 'start', id: 'source' },
  { type: 'write', kind: 'initialize', path: ['choices', 0, 'items', 0], value: { type: 'function_call', ...(callId === undefined ? {} : { call_id: callId }), name: 'tool', arguments: '' } },
  { type: 'write', kind: 'append', path: ['choices', 0, 'items', 0, 'arguments'], value: '{"x":' },
];
const irSuffix = (): IRRecord[] => [
  { type: 'write', kind: 'append', path: ['choices', 0, 'items', 0, 'arguments'], value: '1}' },
  { type: 'item_end', choice: 0, item: 0 },
  { type: 'choice_end', choice: 0, finish_reason: 'tool_calls' },
  { type: 'finish', status: 'completed' },
];

test.each([['Responses', writeOpenAIResponsesEvents], ['Messages', writeAnthropicMessagesEvents]] as const)('%s opens a pending call on the late call_id record', async (name, writer) => {
  const prefix: IRRecord[] = [...irPrefix(),
    { type: 'write', kind: 'initialize', path: ['choices', 0, 'items', 1], value: { type: 'message', content: [] } },
    { type: 'write', kind: 'initialize', path: ['choices', 0, 'items', 1, 'content', 0], value: { type: 'text', text: '' } },
    { type: 'write', kind: 'append', path: ['choices', 0, 'items', 1, 'content', 0, 'text'], value: 'later' }];
  const suffix: IRRecord[] = [
    { type: 'write', kind: 'assign', path: ['choices', 0, 'items', 0, 'call_id'], value: 'call_real' },
    { type: 'write', kind: 'append', path: ['choices', 0, 'items', 0, 'arguments'], value: '1}' },
    { type: 'item_end', choice: 0, item: 0 },
    { type: 'part_end', choice: 0, item: 1, part: 0 },
    { type: 'item_end', choice: 0, item: 1 },
    { type: 'choice_end', choice: 0, finish_reason: 'tool_calls' },
    { type: 'finish', status: 'completed' },
  ];
  const frames = await gated(prefix, suffix, writer, emitted => {
    expect(emitted.some((frame: any) => frame.event?.type === 'response.output_item.added' || frame.event?.type === 'content_block_start')).toBe(false);
  });
  const result: any = await nativeResult(name === 'Responses' ? 'openai-responses' : 'anthropic-messages', frames);
  expect(name === 'Responses' ? result.output[0].call_id : result.content[0].id).toBe('call_real');
});

test.each([['Responses', writeOpenAIResponsesEvents], ['Messages', writeAnthropicMessagesEvents], ['ChatCompletions', writeOpenAIChatCompletionsEvents]] as const)('%s opens call_id IRAbsent without waiting', async (_name, writer) => {
  await gated(irPrefix(IRAbsent), irSuffix(), writer, prefix => {
    expect(prefix.some((frame: any) => frame.event?.type === 'response.output_item.added' || frame.event?.type === 'content_block_start' || frame.event?.choices?.[0]?.delta.tool_calls !== undefined)).toBe(true);
  });
});

const response = (output: any[], status = 'completed') => ({ id: 'resp_lifecycle', model: 'served', status, output, usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 }, error: null, incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null });
const responseStart = eventFrame({ type: 'response.created', response: response([], 'in_progress') } as any);
const add = (index: number, item: any) => eventFrame({ type: 'response.output_item.added', output_index: index, item } as any);
const call = (index: number, arguments_ = '', status = 'in_progress') => ({ type: 'function_call', id: `fc_${index}`, call_id: `call_${index}`, name: `tool${index}`, arguments: arguments_, status });
const args = (index: number, delta: string) => eventFrame({ type: 'response.function_call_arguments.delta', output_index: index, delta } as any);
const endCall = (index: number, arguments_: string, status = 'completed') => eventFrame({ type: 'response.output_item.done', output_index: index, item: call(index, arguments_, status) } as any);

test('Messages closes an earlier concurrent block immediately and the frontier block after its sidecar', async () => {
  const source = [responseStart, add(0, call(0)), args(0, '{"x":'), add(1, call(1)), args(1, '{"y":2}'), endCall(1, '{"y":2}'), args(0, '1}'), endCall(0, '{"x":1}'), eventFrame({ type: 'response.completed', response: response([call(0, '{"x":1}', 'completed'), call(1, '{"y":2}', 'completed')]) } as any)];
  const frames: any[] = await collect(writeAnthropicMessagesEvents(readOpenAIResponsesEvents(iterate(source))));
  const lifecycle = frames.flatMap(frame => frame.event?.type === 'content_block_start'
    ? [`start:${frame.event.index}:${frame.event.content_block.type}`]
    : frame.event?.type === 'content_block_stop' ? [`stop:${frame.event.index}`] : []);
  expect(lifecycle).toEqual([
    'start:0:tool_use',
    'start:1:tool_use',
    'stop:0',
    'start:2:redacted_thinking',
    'stop:2',
    'stop:1',
  ]);
});

test.each([['ChatCompletions', writeOpenAIChatCompletionsEvents], ['Messages', writeAnthropicMessagesEvents], ['GenerateContent', (records: AsyncIterable<IRRecord>) => writeGeminiGenerateContentEvents(records, { includeThoughts: true })]] as const)('%s flattens reasoning content and summary in arrival order', async (name, writer) => {
  const item = { type: 'reasoning', id: 'r', summary: [] };
  const source = [responseStart, add(0, item), eventFrame({ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'reasoning_text', text: '' } } as any), eventFrame({ type: 'response.reasoning_text.delta', output_index: 0, content_index: 0, delta: 'C' } as any), eventFrame({ type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } } as any), eventFrame({ type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'S' } as any), eventFrame({ type: 'response.completed', response: response([{ ...item, content: [{ type: 'reasoning_text', text: 'C' }], summary: [{ type: 'summary_text', text: 'S' }] }]) } as any)];
  const frames: any[] = await collect<any>(writer(readOpenAIResponsesEvents(iterate(source))));
  const text = frames.map(frame => name === 'ChatCompletions' ? frame.event?.choices?.[0]?.delta.reasoning_text ?? '' : name === 'Messages' ? frame.event.delta?.thinking ?? '' : frame.event.candidates?.[0]?.content?.parts?.filter((part: any) => part.thought).map((part: any) => part.text).join('') ?? '').join('');
  expect(text).toBe('CS');
});

test('GenerateContent preserves completed tool order when the second finishes first', async () => {
  const frames = await gated([responseStart, add(0, call(0)), args(0, '{"x":'), add(1, call(1)), args(1, '{}'), endCall(1, '{}')], [args(0, '1}'), endCall(0, '{"x":1}'), eventFrame({ type: 'response.completed', response: response([call(0, '{"x":1}', 'completed'), call(1, '{}', 'completed')]) } as any)], source => writeGeminiGenerateContentEvents(readOpenAIResponsesEvents(source)), output => {
    expect(output).toEqual([]);
  });
  expect(frames.flatMap((frame: any) => frame.event.candidates?.flatMap((candidate: any) => candidate.content?.parts ?? []) ?? []).filter((part: any) => part.functionCall).map((part: any) => part.functionCall.id)).toEqual(['call_0', 'call_1']);
});

test.each([['ChatCompletions', writeOpenAIChatCompletionsEvents], ['Responses', writeOpenAIResponsesEvents], ['GenerateContent', writeGeminiGenerateContentEvents]] as const)('%s preserves Messages token cutoff without parsing incomplete input', async (name, writer) => {
  const source = [messageStart, eventFrame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call', name: 'lookup', input: {} } } as any), eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"x":' } } as any), eventFrame({ type: 'content_block_stop', index: 0 } as any), ...messageEnd('max_tokens')];
  const frames: any[] = await collect<any>(writer(readAnthropicMessagesEvents(iterate(source))));
  if (name === 'ChatCompletions') {
    expect(frames.some(frame => frame.event?.choices?.[0]?.finish_reason === 'length')).toBe(true);
    expect(frames.flatMap(frame => frame.event?.choices?.[0]?.delta.tool_calls ?? []).map(tool => tool.function.arguments ?? '').join('')).toBe('{"x":');
  } else if (name === 'Responses') {
    expect(frames.at(-1).event).toMatchObject({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } });
    expect(frames.at(-1).event.response.output[0]).toMatchObject({ arguments: '{"x":', status: 'incomplete' });
  } else {
    expect(frames.flatMap(frame => frame.event.candidates?.flatMap((candidate: any) => candidate.content?.parts ?? []) ?? []).filter((part: any) => part.thoughtSignature === undefined)).toEqual([]);
    expect(frames.flatMap(frame => frame.event.candidates ?? []).filter(candidate => candidate.finishReason !== undefined)).toEqual([{ index: 0, finishReason: 'MAX_TOKENS' }]);
  }
});

test('Messages publishes cumulative usage progress before pulling the rest of the generation', async () => {
  const initial = chat({ role: 'assistant' });
  initial.event.usage = { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 };
  const first = chat({ content: 'A' });
  first.event.usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
  const last = chat({ content: 'B' }, 'stop');
  last.event.usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
  const output = await gated([initial, first], [last, doneFrame()], frames => writeAnthropicMessagesEvents(readOpenAIChatCompletionsEvents(frames)), prefix => {
    expect(prefix).toContainEqual(expect.objectContaining({ event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A' } } }));
    expect(prefix.some(frame => frame.event?.type === 'message_delta' && frame.event.delta.stop_reason === null && frame.event.usage.output_tokens === 1)).toBe(true);
    expect(prefix.some(frame => frame.event?.delta?.stop_reason === 'end_turn')).toBe(false);
  });
  const final = output.findLast(frame => frame.event?.type === 'message_delta');
  expect(final).toMatchObject({ event: { delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 2 } } });
});
