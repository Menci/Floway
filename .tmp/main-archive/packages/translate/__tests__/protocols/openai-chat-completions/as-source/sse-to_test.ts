import { expect, test } from 'vitest';

import { createIRBuilder } from '../../../../src/ir/stream.ts';
import { openaiChatCompletionsFromIR } from '../../../../src/protocols/openai-chat-completions/as-source/sse-to.ts';
import { createReferenceBuilder, collectContentViews, createFieldState, createReferenceFinalizer, appendField } from '../../../../src/round-trip/reference/reference-builder.ts';
import { type RoundTripWriter } from '../../../../src/round-trip/stream.ts';

test('prepares each Chat choice independently while another choice has partial audio', async () => {
  const source = createIRBuilder(2);
  source.choice(0);
  source.choice(1);
  source.assign(['model'], 'model');
  source.event({ type: 'start', id: 'response' });

  source.initialize(['choices', 1, 'items', 0], { type: 'message', content: [] });
  source.initialize(['choices', 1, 'items', 0, 'content', 0], { type: 'audio', audio: { mime_type: 'audio/wav' } });
  source.initialize(['choices', 1, 'items', 0, 'content', 0, 'audio', 'data'], '');
  source.append(['choices', 1, 'items', 0, 'content', 0, 'audio', 'data'], 'YQ==');

  source.initialize(['choices', 0, 'items', 0], { type: 'message', content: [] });
  source.initialize(['choices', 0, 'items', 0, 'content', 0], { type: 'text', text: '' });
  source.append(['choices', 0, 'items', 0, 'content', 0, 'text'], 'done');
  source.event({ type: 'part_end', choice: 0, item: 0, part: 0 });
  source.event({ type: 'item_end', choice: 0, item: 0 });
  source.event({ type: 'choice_end', choice: 0, finish_reason: 'stop' });

  source.initialize(['choices', 1, 'items', 0, 'content', 0, 'audio', 'transcript'], '');
  source.append(['choices', 1, 'items', 0, 'content', 0, 'audio', 'transcript'], 'a');
  source.event({ type: 'part_end', choice: 1, item: 0, part: 0 });
  source.event({ type: 'item_end', choice: 1, item: 0 });
  source.event({ type: 'choice_end', choice: 1, finish_reason: 'stop' });
  source.event({ type: 'finish', status: 'completed' });

  const prepared: number[] = [];
  const roundTrip: RoundTripWriter<'openaiChatCompletions'> = {
    builder: createReferenceBuilder(),
    prepareSidecar: async choice => { prepared.push(choice); return `sidecar-${choice}`; },
  };
  const frames = [];
  for await (const frame of openaiChatCompletionsFromIR((async function* () { yield* source.drain(); })(), {
    roundTrip,
    audioMetadata: choice => ({ id: `audio-${choice}`, expires_at: 10 }),
  })) frames.push(frame);

  expect(prepared).toEqual([0, 1]);
  expect(JSON.stringify(frames)).toContain('sidecar-0');
  expect(JSON.stringify(frames)).toContain('sidecar-1');
});

test.each([false, true])('resolves delayed transcript provenance at actual projection (audio data: %s)', async hasAudioData => {
  const references = createReferenceBuilder();
  const transcript = createFieldState('text');
  const first = appendField(references, transcript, 'late ');
  const second = appendField(references, transcript, 'text');
  const source = createIRBuilder();
  source.choice(0);
  source.assign(['model'], 'model');
  source.event({ type: 'start', id: 'response' });
  const audio = source.item(0, { type: 'message', content: [] });
  const audioPart = audio.part({ type: 'audio', audio: { transcript: '' } });
  audioPart.append(['audio', 'transcript'], 'late ', [first]);
  const message = source.item(0, { type: 'message', content: [] });
  const text = message.part({ type: 'text', text: '' });
  text.append('text', 'early ');
  text.end();
  message.end();
  audioPart.append(['audio', 'transcript'], 'text', [second]);
  if (hasAudioData) {
    audioPart.initialize(['audio', 'data'], '');
    audioPart.append(['audio', 'data'], 'YQ==');
  }
  audioPart.end();
  audio.end();
  source.choice(0).end('stop');
  source.event({ type: 'finish', status: 'completed' });

  let prepared: Parameters<RoundTripWriter<'openaiChatCompletions'>['prepareSidecar']> | undefined;
  const roundTrip: RoundTripWriter<'openaiChatCompletions'> = {
    builder: references,
    prepareSidecar: async (...args) => { prepared = args; return 'sidecar'; },
  };
  for await (const _frame of openaiChatCompletionsFromIR((async function* () { yield* source.drain(); })(), {
    roundTrip, audioMetadata: () => ({ id: 'audio', expires_at: 10 }),
  })) {}
  if (prepared === undefined) throw new Error('ChatCompletions sidecar was not prepared');
  const [, , turn, state] = prepared;
  const finalizer = createReferenceFinalizer(references, collectContentViews(turn, state));
  expect(turn.content).toBe(hasAudioData ? 'early ' : 'early late text');
  expect(await finalizer.finalizeField('late text', transcript)).toEqual(hasAudioData ? 'late text' : expect.objectContaining({ parts: [[0, 6, 15]] }));
  if (hasAudioData) expect(turn.audio).toEqual({ id: 'audio' });
});
