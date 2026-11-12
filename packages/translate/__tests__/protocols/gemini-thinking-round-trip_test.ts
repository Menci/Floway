import { expect, test } from 'vitest';

import { createTestSidecarCodec } from '../round-trip/sidecar-codec.ts';
import { iterate } from '../shared/iterables.ts';
import { expectTrip } from '../trip.ts';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import { collectGeminiGenerateContentProtocolEventsToResult } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { routeGeminiGenerateContentViaOpenAIChatCompletions } from '@floway-dev/translate';

const upstream = async function* (): AsyncGenerator<ReturnType<typeof eventFrame<OpenAIChatCompletionsStreamEvent>> | ReturnType<typeof doneFrame>> {
  yield eventFrame({
    id: 'chat', model: 'm', object: 'chat.completion.chunk', created: 1,
    choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'secret' }, finish_reason: null }],
  });
  yield eventFrame({
    id: 'chat', model: 'm', object: 'chat.completion.chunk', created: 1,
    choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: 'stop' }],
  });
  yield doneFrame();
};

test('includeThoughts controls only visible plaintext', async () => {
  const options = { sidecarCodec: createTestSidecarCodec() };
  const runs = await Promise.all([false, true].map(async includeThoughts => {
    const trip = expectTrip(await routeGeminiGenerateContentViaOpenAIChatCompletions({
      model: 'm', contents: [{ role: 'user', parts: [{ text: 'question' }] }],
      generationConfig: { thinkingConfig: { includeThoughts } },
    }, options));
    const frames = [];
    for await (const frame of trip.events(upstream())) frames.push(frame);
    const result = await collectGeminiGenerateContentProtocolEventsToResult(iterate(frames));
    const content = result.candidates?.[0]?.content;
    if (content === undefined) throw new Error('Expected translated Gemini content.');
    return { includeThoughts, target: trip.target, frames, content };
  }));

  expect(runs[0].target).toEqual(runs[1].target);
  expect(JSON.stringify(runs[0].frames)).not.toContain('secret');
  expect(JSON.stringify(runs[1].frames)).toContain('secret');
  for (const run of runs) {
    expect(run.content.parts?.some(part => part.thoughtSignature !== undefined)).toBe(true);
    const replay = expectTrip(await routeGeminiGenerateContentViaOpenAIChatCompletions({ model: 'm', contents: [run.content] }, options));
    expect(replay.target.messages).toContainEqual(expect.objectContaining({ role: 'assistant', content: 'answer', reasoning_content: 'secret' }));
  }
});
