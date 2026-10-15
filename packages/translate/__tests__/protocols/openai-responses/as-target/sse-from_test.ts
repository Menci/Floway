import { expect, test } from 'vitest';

import { irFromOpenAIResponses } from '../../../../src/protocols/openai-responses/as-target/sse-from.ts';
import { hydrateAssistantTurn } from '../../../../src/round-trip/thin/hydrate.ts';
import { appendContent, collectContentViews, createContentState, finalizeAssistantTurnReferences } from '../../../../src/round-trip/thin/reference-builder.ts';
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

const collectProvenance = async (events: readonly OpenAIResponsesStreamEventEx[]) => {
  const capture = createRoundTripReaderCapture<'openaiResponses'>();
  const content = createContentState(capture.builder);
  const appends: { text: string; partIds?: readonly number[] }[] = [];
  const frames = (async function* () {
    for (const event of events) yield eventFrame(event);
  })();

  for await (const record of irFromOpenAIResponses(frames, { roundTrip: capture.roundTrip })) {
    if (record.type !== 'operation' || record.operation !== 'append' || record.path.at(-1) !== 'text') continue;
    appends.push({ text: record.value, ...(record.partIds === undefined ? {} : { partIds: record.partIds }) });
    appendContent(capture.builder, content, record.value, record.partIds);
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

  expect(captured.appends).toEqual([{ text: 'hel', partIds: [0] }, { text: 'lo' }]);
  expect([...collectContentViews('hello', captured.content).values()]).toEqual(['hello']);
  const itemState = captured.fieldState[0];
  if (itemState === undefined || !('content' in itemState)) throw new Error('Responses message state was not collected');
  if (!Array.isArray(itemState.content)) throw new Error('Responses message content state was not collected');
  expect(itemState.content[0]).toEqual({});

  const finalized = await finalizeAssistantTurnReferences<'openaiResponses'>(
    captured.turn,
    captured.fieldState,
    captured.builder,
    collectContentViews('hello', captured.content),
  );
  expect(finalized.assistantTurn).toEqual(captured.turn);
  expect(Object.hasOwn(finalized, 'referencedContents')).toBe(false);
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

  expect(captured.appends).toEqual([{ text: 'hello', partIds: [0] }]);
  const finalized = await finalizeAssistantTurnReferences<'openaiResponses'>(
    captured.turn,
    captured.fieldState,
    captured.builder,
    collectContentViews('hello', captured.content),
  );
  const item = finalized.assistantTurn[0];
  if (item?.type !== 'message' || !Array.isArray(item.content)) throw new Error('Expected a Responses message item');
  const part = item.content[0];
  if (part?.type !== 'output_text') throw new Error('Expected a Responses output text part');
  expect(part.text).toBe('hello');
  expect(finalized).not.toHaveProperty('referencedContents');
  expect(await hydrateAssistantTurn(
    'openaiResponses',
    ['hello'],
    finalized.assistantTurn,
    finalized.referencedContents,
  )).toEqual({ ok: true, turn: captured.turn });
});
