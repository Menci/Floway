import { expect, test } from 'vitest';

import { createIRBuilder } from '../../../../src/ir/stream.ts';
import { openaiChatCompletionsFromIR } from '../../../../src/protocols/openai-chat-completions/as-source/sse-to.ts';
import type { RoundTripWriter } from '../../../../src/round-trip/stream.ts';
import { createReferenceBuilder } from '../../../../src/round-trip/thin/reference-builder.ts';

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
