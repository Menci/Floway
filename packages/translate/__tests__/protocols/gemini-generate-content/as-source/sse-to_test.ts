import { expect, test } from 'vitest';

import { createIRBuilder } from '../../../../src/ir/stream.ts';
import { geminiGenerateContentFromIR } from '../../../../src/protocols/gemini-generate-content/as-source/sse-to.ts';
import { type RoundTripWriter } from '../../../../src/round-trip/stream.ts';
import { appendField, collectContentViews, createReferenceBuilder, createFieldState, createReferenceFinalizer } from '../../../../src/round-trip/thin/reference-builder.ts';

test('resolves delayed Gemini audio atoms within the complete emitted data field', async () => {
  const references = createReferenceBuilder();
  const field = createFieldState();
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
    prepareSidecar: async (_choice, _check, turn, state) => {
      const views = collectContentViews(turn, state);
      expect([...views.values()]).toEqual(['YQ==']);
      const finalizer = await createReferenceFinalizer(references, views);
      expect(await finalizer.finalizeField('Q==', field)).toMatchObject({ value: [[0, 1, 4]] });
      prepared = true;
      return 'sidecar';
    },
  };
  for await (const _frame of geminiGenerateContentFromIR((async function* () { yield* source.drain(); })(), { roundTrip })) {}
  expect(prepared).toBe(true);
});
