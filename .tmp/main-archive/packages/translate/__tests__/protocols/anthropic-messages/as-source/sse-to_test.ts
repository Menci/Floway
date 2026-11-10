import { expect, test } from 'vitest';

import { createIRBuilder } from '../../../../src/ir/stream.ts';
import { anthropicMessagesFromIR } from '../../../../src/protocols/anthropic-messages/as-source/sse-to.ts';
import { appendField, collectContentViews, createReferenceBuilder, createFieldState, createReferenceFinalizer } from '../../../../src/round-trip/reference/reference-builder.ts';
import { type RoundTripWriter } from '../../../../src/round-trip/stream.ts';
import { hashRoundTripContent } from '../../../../src/round-trip/turn-digest.ts';
import { type AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';

test.each(['text', 'refusal', 'audio'] as const)('resolves blocked %s against the emitted Messages text field', async kind => {
  const references = createReferenceBuilder();
  const field = createFieldState('text');
  const parts = ['H', 'i'].map(text => appendField(references, field, text));
  const source = createIRBuilder();
  source.choice(0);
  source.assign(['model'], 'model');
  source.event({ type: 'start', id: 'response' });
  const tool = source.item(0, { type: 'function_call', name: 'blocker', arguments: '' });
  tool.append('arguments', '{}');
  const message = source.item(0, { type: 'message', content: [] });
  const part = message.part(kind === 'audio' ? { type: 'audio', audio: { transcript: '' } } : { type: kind, [kind]: '' });
  const path = kind === 'audio' ? ['audio', 'transcript'] : kind;
  part.append(path, 'H', [parts[0]]);
  part.append(path, 'i', [parts[1]]);
  tool.assign('call_id', 'blocker');
  part.end();
  message.end();
  tool.end();
  source.choice(0).end('tool_calls');
  source.event({ type: 'finish', status: 'completed' });
  let prepared = false;
  const roundTrip: RoundTripWriter<'anthropicMessages'> = {
    builder: references,
    prepareSidecar: async (_choice, _check, turn, state, textViews) => {
      const views = collectContentViews(turn, state, textViews);
      expect([...views.values()]).toContainEqual({ text: 'Hi', offset: 0 });
      const finalizer = createReferenceFinalizer(references, views);
      expect(await finalizer.finalizeField('Hi', field)).toMatchObject({ parts: [0] });
      expect(finalizer.referencedContentHashes).toEqual([await hashRoundTripContent('Hi')]);
      prepared = true;
      return 'sidecar';
    },
  };
  const events: AnthropicMessagesStreamEventEx[] = [];
  for await (const frame of anthropicMessagesFromIR((async function* () { yield* source.drain(); })(), { roundTrip })) events.push(frame.event);
  expect(events.flatMap(event => event.type === 'content_block_delta' && event.delta.type === 'text_delta' ? [event.delta.text] : [])).toEqual(['Hi']);
  expect(prepared).toBe(true);
});

test('resolves blocked reasoning in emitted summary/content order before live appends', async () => {
  const references = createReferenceBuilder();
  const summary = createFieldState('text');
  const content = createFieldState('text');
  const a = appendField(references, summary, 'A');
  const x = appendField(references, content, 'X');
  const b = appendField(references, summary, 'B');
  const c = appendField(references, summary, 'C');
  const source = createIRBuilder();
  source.choice(0);
  source.assign(['model'], 'model');
  source.event({ type: 'start', id: 'response' });
  const tool = source.item(0, { type: 'function_call', name: 'blocker', arguments: '' });
  tool.append('arguments', '{}');
  const reasoning = source.item(0, { type: 'reasoning', summary: [''], content: [''] });
  reasoning.append(['summary', 0], 'A', [a]);
  reasoning.append(['content', 0], 'X', [x]);
  reasoning.append(['summary', 0], 'B', [b]);
  tool.assign('call_id', 'blocker');
  reasoning.append(['summary', 0], 'C', [c]);
  reasoning.end();
  tool.end();
  source.choice(0).end('tool_calls');
  source.event({ type: 'finish', status: 'completed' });

  let prepared: Parameters<RoundTripWriter<'anthropicMessages'>['prepareSidecar']> | undefined;
  const roundTrip: RoundTripWriter<'anthropicMessages'> = {
    builder: references,
    prepareSidecar: async (...args) => { prepared = args; return 'sidecar'; },
  };
  const events: AnthropicMessagesStreamEventEx[] = [];
  for await (const frame of anthropicMessagesFromIR((async function* () { yield* source.drain(); })(), { roundTrip })) events.push(frame.event);
  expect(events.flatMap(event => event.type === 'content_block_delta' && event.delta.type === 'thinking_delta' ? [event.delta.thinking] : [])).toEqual(['ABX', 'C']);
  if (prepared === undefined) throw new Error('Messages sidecar was not prepared');
  const [, , turn, state] = prepared;
  expect(turn.content).toContainEqual(expect.objectContaining({ type: 'thinking', thinking: 'ABXC' }));
  const finalizer = createReferenceFinalizer(references, collectContentViews(turn, state));
  expect(await finalizer.finalizeField('ABC', summary)).toMatchObject({ parts: [[0, 0, 2], [0, 3, 4]] });
  expect(await finalizer.finalizeField('X', content)).toMatchObject({ parts: [[0, 2, 3]] });
  expect(finalizer.referencedContentHashes).toEqual([await hashRoundTripContent('ABXC')]);
});

test.each(['{"x":1,}', '{"x": 1}'])('tracks the emitted canonical JSON view without resolving transformed atoms: %s', async original => {
  const references = createReferenceBuilder();
  const field = createFieldState('text');
  const partId = appendField(references, field, original);
  const source = createIRBuilder();
  source.choice(0);
  source.assign(['model'], 'model');
  source.event({ type: 'start', id: 'response' });
  const tool = source.item(0, { type: 'function_call', name: 'tool', call_id: 'call', arguments: '' });
  tool.append('arguments', original, [partId]);
  tool.end();
  source.choice(0).end('tool_calls');
  source.event({ type: 'finish', status: 'completed' });
  let prepared = false;
  const roundTrip: RoundTripWriter<'anthropicMessages'> = {
    builder: references,
    prepareSidecar: async (_choice, _check, turn, state, textViews) => {
      const views = collectContentViews(turn, state, textViews);
      expect([...views.values()]).toContainEqual({ text: '{"x":1}', offset: 0 });
      const finalizer = createReferenceFinalizer(references, views);
      expect(await finalizer.finalizeField(original, field)).toBe(original);
      prepared = true;
      return 'sidecar';
    },
  };
  for await (const _frame of anthropicMessagesFromIR((async function* () { yield* source.drain(); })(), { roundTrip, parseToolArguments: original.endsWith(',}') ? () => ({ x: 1 }) : undefined })) {}
  expect(prepared).toBe(true);
});
