import { expect, test } from 'vitest';

import { createIRBuilder } from '../../../../src/ir/stream.ts';
import { geminiGenerateContentFromIR } from '../../../../src/protocols/gemini-generate-content/as-source/sse-to.ts';
import { appendField, collectContentViews, createReferenceBuilder, createFieldState, createReferenceFinalizer } from '../../../../src/round-trip/reference/reference-builder.ts';
import { type RoundTripWriter } from '../../../../src/round-trip/stream.ts';

test('resolves delayed Gemini audio atoms within the complete emitted data field', async () => {
  const references = createReferenceBuilder();
  const field = createFieldState('text');
  const partId = appendField(references, field, 'Q==');
  const source = createIRBuilder();
  source.choice(0);
  source.assign(['model'], 'model');
  source.event({ type: 'start', id: 'response' });
  const message = source.item(0, { type: 'message', content: [] });
  const audio = message.part({ type: 'audio', audio: { data: '', mime_type: 'audio/wav' } });
  audio.append(['audio', 'data'], 'Y');
  audio.append(['audio', 'data'], 'Q==', [partId]);
  audio.end();
  message.end();
  source.choice(0).end('stop');
  source.event({ type: 'finish', status: 'completed' });
  let prepared = false;
  const roundTrip: RoundTripWriter<'geminiGenerateContent'> = {
    builder: references,
    prepareSidecar: async (_choice, _check, turn, state, textViews) => {
      const views = collectContentViews(turn, state, textViews);
      expect([...views.values()]).toEqual([{ text: 'YQ==', offset: 0 }]);
      const finalizer = createReferenceFinalizer(references, views);
      expect(await finalizer.finalizeField('Q==', field)).toMatchObject({ parts: [[0, 1, 4]] });
      prepared = true;
      return 'sidecar';
    },
  };
  for await (const _frame of geminiGenerateContentFromIR((async function* () { yield* source.drain(); })(), { roundTrip })) {}
  expect(prepared).toBe(true);
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
  const roundTrip: RoundTripWriter<'geminiGenerateContent'> = {
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
  for await (const _frame of geminiGenerateContentFromIR((async function* () { yield* source.drain(); })(), { roundTrip, parseToolArguments: original.endsWith(',}') ? () => ({ x: 1 }) : undefined })) {}
  expect(prepared).toBe(true);
});
