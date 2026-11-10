import { expect, test } from 'vitest';

import { irFromOpenAIResponses } from '../../../../src/protocols/openai-responses/as-target/sse-from.ts';
import { appendContent, collectContentViews, createContentState } from '../../../../src/round-trip/reference/reference-builder.ts';
import { finalizeAssistantTurnReferences } from '../../../../src/round-trip/reference/reference-selection.ts';
import { restoreAssistantTurn } from '../../../../src/round-trip/reference/restore.ts';
import { createRoundTripReaderCapture } from '../../../round-trip/test-helpers.ts';
import { eventFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesOutputItemEx, OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

type OutputMessage = Extract<OpenAIResponsesOutputItemEx, { type: 'message' }>;

const response = (output: OpenAIResponsesOutputItemEx[], status: OpenAIResponsesResultEx['status']): OpenAIResponsesResultEx => ({
  id: 'resp',
  object: 'response',
  created_at: 1,
  model: 'served',
  status,
  output,
  usage: null,
  error: null,
  incomplete_details: null,
});

const message = (text: string, status: OutputMessage['status']): OutputMessage => ({
  type: 'message',
  id: 'msg',
  role: 'assistant',
  status,
  content: text === '' ? [] : [{ type: 'output_text', text, annotations: [], logprobs: [] }],
});

const refusalMessage = (refusal: string, status: OutputMessage['status']): OutputMessage => ({
  type: 'message',
  id: 'msg',
  role: 'assistant',
  status,
  content: refusal === '' ? [] : [{ type: 'refusal', refusal }],
});

const collectProvenance = async (events: readonly OpenAIResponsesStreamEventEx[], field: 'text' | 'refusal' | 'arguments' | 'input' = 'text') => {
  const capture = createRoundTripReaderCapture<'openaiResponses'>();
  const content = createContentState(capture.builder, 'text');
  const appends: { text: string; referencePieceIds?: readonly number[] }[] = [];
  const frames = (async function* () {
    for (const event of events) yield eventFrame(event);
  })();

  for await (const record of irFromOpenAIResponses(frames, { roundTrip: capture.roundTrip })) {
    if (record.type !== 'write' || record.kind !== 'append' || record.path.at(-1) !== field) continue;
    appends.push({ text: record.value, ...(record.referencePieceIds === undefined ? {} : { referencePieceIds: record.referencePieceIds }) });
    appendContent(capture.builder, content, record.value, record.referencePieceIds);
  }

  const captured = capture.turns.get(0);
  if (captured === undefined) throw new Error('Responses assistant turn was not collected');
  return { ...capture, ...captured, content, appends };
};

test('keeps the whole field literal when a done snapshot supplies a suffix without SSE provenance', async () => {
  const added = message('', 'in_progress');
  const done = message('hello', 'completed');
  const captured = await collectProvenance([
    { type: 'response.created', response: response([], 'in_progress') },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.content_part.added', item_id: 'msg', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [], logprobs: [] } },
    { type: 'response.output_text.delta', item_id: 'msg', output_index: 0, content_index: 0, delta: 'hel', logprobs: [] },
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: response([done], 'completed') },
  ]);

  expect(captured.appends).toEqual([{ text: 'hel', referencePieceIds: [0] }, { text: 'lo' }]);
  expect([...collectContentViews('hello', captured.content).values()]).toEqual([{ text: 'hello', offset: 0 }]);
  const itemState = captured.fieldState[0];
  if (itemState === undefined || !('content' in itemState)) throw new Error('Responses message state was not collected');
  if (!Array.isArray(itemState.content)) throw new Error('Responses message content state was not collected');
  expect(itemState.content[0]).toMatchObject({ text: { valid: false } });

  const finalized = await finalizeAssistantTurnReferences<'openaiResponses'>(
    captured.turn,
    captured.fieldState,
    captured.builder,
    collectContentViews('hello', captured.content),
  );
  expect(finalized.targetTurn).toEqual(captured.turn);
  expect(Object.hasOwn(finalized, 'referencedContentHashes')).toBe(false);
});

test('keeps a tiny complete snapshot-only atom literal and hydrates the native Responses turn', async () => {
  const added = message('', 'in_progress');
  const done = message('hello', 'completed');
  const captured = await collectProvenance([
    { type: 'response.created', response: response([], 'in_progress') },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: response([done], 'completed') },
  ]);

  expect(captured.appends).toEqual([{ text: 'hello', referencePieceIds: [0] }]);
  const finalized = await finalizeAssistantTurnReferences<'openaiResponses'>(
    captured.turn,
    captured.fieldState,
    captured.builder,
    collectContentViews('hello', captured.content),
  );
  const item = finalized.targetTurn[0];
  if (item?.type !== 'message' || !Array.isArray(item.content)) throw new Error('Expected a Responses message item');
  const part = item.content[0];
  if (part?.type !== 'output_text') throw new Error('Expected a Responses output text part');
  expect(part.text).toBe('hello');
  expect(finalized).not.toHaveProperty('referencedContentHashes');
  expect(await restoreAssistantTurn(
    'openaiResponses',
    ['hello'],
    finalized.targetTurn,
    finalized.referencedContentHashes,
  )).toEqual({ ok: true, turn: captured.turn });
});

test('invalidates streamed refusal provenance when its done snapshot supplies a suffix', async () => {
  const added = refusalMessage('', 'in_progress');
  const done = refusalMessage('refused', 'completed');
  const captured = await collectProvenance([
    { type: 'response.created', response: response([], 'in_progress') },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.content_part.added', item_id: 'msg', output_index: 0, content_index: 0, part: { type: 'refusal', refusal: '' } },
    { type: 'response.refusal.delta', item_id: 'msg', output_index: 0, content_index: 0, delta: 'refu' },
    { type: 'response.refusal.done', item_id: 'msg', output_index: 0, content_index: 0, refusal: 'refused' },
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: response([done], 'completed') },
  ], 'refusal');

  expect(captured.appends).toEqual([{ text: 'refu', referencePieceIds: [0] }, { text: 'sed' }]);
  const itemState = captured.fieldState[0];
  if (itemState === undefined || !('content' in itemState) || !Array.isArray(itemState.content)) {
    throw new Error('Responses message content state was not collected');
  }
  expect(itemState.content[0]).toMatchObject({ refusal: { valid: false } });
  const finalized = await finalizeAssistantTurnReferences<'openaiResponses'>(captured.turn, captured.fieldState, captured.builder, collectContentViews('refused', captured.content));
  expect(finalized).not.toHaveProperty('referencedContentHashes');
  expect(await restoreAssistantTurn('openaiResponses', ['refused'], finalized.targetTurn, finalized.referencedContentHashes)).toEqual({ ok: true, turn: captured.turn });
});

test('collects a snapshot-only refusal through its refusal field state', async () => {
  const added = refusalMessage('', 'in_progress');
  const done = refusalMessage('refused', 'completed');
  const captured = await collectProvenance([
    { type: 'response.created', response: response([], 'in_progress') },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: response([done], 'completed') },
  ], 'refusal');

  expect(captured.appends).toEqual([{ text: 'refused', referencePieceIds: [0] }]);
  const finalized = await finalizeAssistantTurnReferences<'openaiResponses'>(captured.turn, captured.fieldState, captured.builder, collectContentViews('refused', captured.content));
  expect(finalized).not.toHaveProperty('referencedContentHashes');
  expect(await restoreAssistantTurn('openaiResponses', ['refused'], finalized.targetTurn, finalized.referencedContentHashes)).toEqual({ ok: true, turn: captured.turn });
});

type ToolItem = Extract<OpenAIResponsesOutputItemEx, { type: 'function_call' | 'custom_tool_call' }>;

const toolItem = (type: ToolItem['type'], text: string, status: 'in_progress' | 'completed'): ToolItem => type === 'function_call'
  ? { type, id: 'tool', call_id: 'call', name: 'lookup', arguments: text, status }
  : { type, id: 'tool', call_id: 'call', name: 'lookup', input: text, status };

const toolCases = [
  { type: 'function_call', field: 'arguments', prefix: '{"x":', suffix: '1}' },
  { type: 'custom_tool_call', field: 'input', prefix: 'hel', suffix: 'lo' },
] as const;

const toolDelta = (type: ToolItem['type'], delta: string): OpenAIResponsesStreamEventEx => type === 'function_call'
  ? { type: 'response.function_call_arguments.delta', item_id: 'tool', output_index: 0, delta }
  : { type: 'response.custom_tool_call_input.delta', item_id: 'tool', output_index: 0, delta };

const toolDone = (type: ToolItem['type'], text: string): OpenAIResponsesStreamEventEx => type === 'function_call'
  ? { type: 'response.function_call_arguments.done', item_id: 'tool', output_index: 0, name: 'lookup', arguments: text }
  : { type: 'response.custom_tool_call_input.done', item_id: 'tool', output_index: 0, input: text };

test.each(toolCases)('collects streamed native $type text through its existing state node and inlines the tiny field', async ({ type, field, prefix, suffix }) => {
  const text = prefix + suffix;
  const done = toolItem(type, text, 'completed');
  const captured = await collectProvenance([
    { type: 'response.created', response: response([], 'in_progress') },
    { type: 'response.output_item.added', output_index: 0, item: toolItem(type, '', 'in_progress') },
    toolDelta(type, prefix), toolDelta(type, suffix), toolDone(type, text),
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: response([done], 'completed') },
  ], field);
  expect(captured.appends).toEqual([{ text: prefix, referencePieceIds: [0] }, { text: suffix, referencePieceIds: [1] }]);
  expect(captured.fieldState[0]).toHaveProperty(field, expect.any(Object));
  const finalized = await finalizeAssistantTurnReferences<'openaiResponses'>(captured.turn, captured.fieldState, captured.builder, collectContentViews(text, captured.content));
  expect(finalized.targetTurn[0]).toHaveProperty(field, text);
  expect(finalized).not.toHaveProperty('referencedContentHashes');
  expect(await restoreAssistantTurn('openaiResponses', [text], finalized.targetTurn, finalized.referencedContentHashes)).toEqual({ ok: true, turn: captured.turn });
});

test.each(toolCases)('collects a snapshot-only native $type atom and inlines the tiny field', async ({ type, field, prefix, suffix }) => {
  const text = prefix + suffix;
  const done = toolItem(type, text, 'completed');
  const captured = await collectProvenance([
    { type: 'response.created', response: response([], 'in_progress') },
    { type: 'response.output_item.added', output_index: 0, item: toolItem(type, '', 'in_progress') },
    toolDone(type, text),
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: response([done], 'completed') },
  ], field);
  expect(captured.appends).toEqual([{ text, referencePieceIds: [0] }]);
  const finalized = await finalizeAssistantTurnReferences<'openaiResponses'>(captured.turn, captured.fieldState, captured.builder, collectContentViews(text, captured.content));
  expect(finalized.targetTurn[0]).toHaveProperty(field, text);
  expect(finalized).not.toHaveProperty('referencedContentHashes');
  expect(await restoreAssistantTurn('openaiResponses', [text], finalized.targetTurn, finalized.referencedContentHashes)).toEqual({ ok: true, turn: captured.turn });
});

test.each(toolCases)('invalidates native $type provenance when its done snapshot extends a delta', async ({ type, field, prefix, suffix }) => {
  const text = prefix + suffix;
  const done = toolItem(type, text, 'completed');
  const captured = await collectProvenance([
    { type: 'response.created', response: response([], 'in_progress') },
    { type: 'response.output_item.added', output_index: 0, item: toolItem(type, '', 'in_progress') },
    toolDelta(type, prefix), toolDone(type, text),
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: response([done], 'completed') },
  ], field);
  expect(captured.appends).toEqual([{ text: prefix, referencePieceIds: [0] }, { text: suffix }]);
  expect(captured.fieldState[0]).toMatchObject({ [field]: { valid: false } });
  const finalized = await finalizeAssistantTurnReferences<'openaiResponses'>(captured.turn, captured.fieldState, captured.builder, collectContentViews(text, captured.content));
  expect(finalized.targetTurn).toEqual(captured.turn);
  expect(finalized).not.toHaveProperty('referencedContentHashes');
});
