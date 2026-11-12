import { expect, test } from 'vitest';

import { createTestSidecarCodec } from '../round-trip/sidecar-codec.ts';
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

test.each([false, true])('includeThoughts=%s controls plaintext without changing sidecar replay', async includeThoughts => {
  const options = { sidecarCodec: createTestSidecarCodec() };
  const trip = expectTrip(await routeGeminiGenerateContentViaOpenAIChatCompletions({
    model: 'm', contents: [{ role: 'user', parts: [{ text: 'question' }] }],
    generationConfig: { thinkingConfig: { includeThoughts } },
  }, options));
  const result = await collectGeminiGenerateContentProtocolEventsToResult(trip.events(upstream()));
  const content = result.candidates?.[0]?.content;
  if (content === undefined) throw new Error('Expected translated Gemini content.');
  const thoughts = content.parts?.filter(part => part.thought === true) ?? [];
  expect(thoughts.map(part => part.text)).toContain(includeThoughts ? 'secret' : '');
  expect(thoughts.map(part => part.text)).not.toContain(includeThoughts ? '' : 'secret');
  expect(content.parts?.some(part => part.thoughtSignature !== undefined)).toBe(true);

  const replay = expectTrip(await routeGeminiGenerateContentViaOpenAIChatCompletions({ model: 'm', contents: [content] }, options));
  expect(replay.target.messages).toContainEqual(expect.objectContaining({ role: 'assistant', content: 'answer', reasoning_content: 'secret' }));
});
