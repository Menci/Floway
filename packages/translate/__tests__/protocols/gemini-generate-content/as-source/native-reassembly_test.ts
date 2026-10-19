import { expect, test, vi } from 'vitest';

import { computeGeminiGenerateContentTurnDigest } from '../../../../src/protocols/gemini-generate-content/as-source/round-trip.ts';
import { createTestSidecarCodec } from '../../../round-trip/sidecar-codec.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { createGeminiGenerateContentEventAccumulator, reassembleGeminiGenerateContentEvents } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { routeGeminiGenerateContent } from '@floway-dev/translate/gemini-generate-content';

vi.mock('@floway-dev/protocols/gemini-generate-content', async importOriginal => {
  const actual = await importOriginal<typeof import('@floway-dev/protocols/gemini-generate-content')>();
  return {
    ...actual,
    createGeminiGenerateContentEventAccumulator: vi.fn(() => {
      const accumulator = actual.createGeminiGenerateContentEventAccumulator();
      return { ...accumulator, candidate: vi.fn(accumulator.candidate), result: vi.fn(accumulator.result) };
    }),
  };
});

const chatFrames = async function* (count: number): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
  for (let index = 0; index < count; index++) yield eventFrame({
    id: 'chat', object: 'chat.completion.chunk', created: 1, model: 'target',
    choices: [{ index, delta: { role: 'assistant', content: `answer-${index}` }, finish_reason: null }],
  });
  for (let index = count - 1; index >= 0; index--) yield eventFrame({
    id: 'chat', object: 'chat.completion.chunk', created: 1, model: 'target',
    choices: [{ index, delta: {}, finish_reason: 'stop' }],
  });
  yield doneFrame();
};

test.each([2, 32])('reads only the ending candidate for %i interleaved choices', async count => {
  vi.mocked(createGeminiGenerateContentEventAccumulator).mockClear();
  const codec = createTestSidecarCodec();
  const trip = await routeGeminiGenerateContent({
    contents: [{ role: 'user', parts: [{ text: 'question' }] }], generationConfig: { candidateCount: count },
  }).viaOpenAIChatCompletions({ model: 'target', sidecarCodec: codec });
  const events = async function* () {
    for await (const frame of trip.events(chatFrames(count))) if (frame.type === 'event') yield frame.event;
  };
  const result = await reassembleGeminiGenerateContentEvents(events());
  expect(result.candidates).toHaveLength(count);
  for (const [index, candidate] of (result.candidates ?? []).entries()) {
    expect(candidate.index).toBe(index);
    expect(candidate.finishReason).toBe('STOP');
    expect(candidate.content?.parts?.filter(part => part.text !== undefined)).toEqual([{ text: `answer-${index}` }]);
    const carrier = candidate.content?.parts?.find(part => part.thoughtSignature !== undefined)?.thoughtSignature;
    if (carrier === undefined) throw new Error('Expected a round-trip sidecar');
    expect(await codec.decode(carrier)).toMatchObject({
      sourceTurnDigest: await computeGeminiGenerateContentTurnDigest([{ role: 'model', parts: [{ text: `answer-${index}` }] }]),
    });
  }
  expect(createGeminiGenerateContentEventAccumulator).toHaveBeenCalledTimes(1);
  const creation = vi.mocked(createGeminiGenerateContentEventAccumulator).mock.results[0];
  if (creation.type !== 'return') throw new Error('Expected the native accumulator');
  expect(creation.value.result).not.toHaveBeenCalled();
  expect(creation.value.candidate).toHaveBeenCalledTimes(count);
});
