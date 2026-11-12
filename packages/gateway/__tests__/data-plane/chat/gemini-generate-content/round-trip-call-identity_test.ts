import { expect, test } from 'vitest';

import { createSidecarCodecFactory, SidecarDomain } from '../../../../src/data-plane/chat/shared/sidecar-codec.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { collectGeminiGenerateContentProtocolEventsToResult } from '@floway-dev/protocols/gemini-generate-content';
import type { GeminiGenerateContentContent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { routeGeminiGenerateContentViaOpenAIChatCompletions } from '@floway-dev/translate';

test.each([{ modernIds: ['legacy_call_1'] }, { modernIds: ['legacy_call_1', 'legacy_call_2'] }])('signed legacy Chat replay preserves later modern call IDs: $modernIds', async ({ modernIds }) => {
  const codec = () => createSidecarCodecFactory('native-legacy-call-identity').codecFor(SidecarDomain.TranslatedAssistantTurn);
  const question: GeminiGenerateContentContent = { role: 'user', parts: [{ text: 'question' }] };
  const first = await routeGeminiGenerateContentViaOpenAIChatCompletions({ model: 'model', contents: [question] }, { sidecarCodec: codec() });
  if (first.type === 'input-error') throw new Error(first.message);
  const upstream = async function* (): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
    yield eventFrame({
      id: 'legacy', object: 'chat.completion.chunk', created: 1, model: 'model',
      choices: [{ index: 0, delta: { role: 'assistant', function_call: { name: 'lookup', arguments: '{}' } }, finish_reason: 'function_call' }],
    });
    yield doneFrame();
  };
  const produced = await collectGeminiGenerateContentProtocolEventsToResult(first.events(upstream()));
  const native = produced.candidates?.[0]?.content;
  if (native === undefined) throw new Error('Expected the generated Gemini assistant turn');
  expect(native.parts?.some(part => typeof part.thoughtSignature === 'string')).toBe(true);

  const replay = await routeGeminiGenerateContentViaOpenAIChatCompletions({
    model: 'model',
    contents: [
      question,
      native,
      { role: 'user', parts: [{ functionResponse: { name: 'lookup', response: 'LEGACY' } }] },
      ...modernIds.flatMap((id, index): GeminiGenerateContentContent[] => [
        { role: 'model', parts: [{ functionCall: { id, name: `modern_${index}`, args: {} } }] },
        { role: 'user', parts: [{ functionResponse: { id, name: `modern_${index}`, response: `MODERN_${index}` } }] },
      ]),
    ],
  }, { sidecarCodec: codec() });
  if (replay.type === 'input-error') throw new Error(replay.message);
  expect(replay.target.messages[1]).toMatchObject({ role: 'assistant', function_call: { name: 'lookup', arguments: '{}' } });
  expect(replay.target.messages[2]).toEqual({ role: 'function', name: 'lookup', content: '"LEGACY"' });
  expect(replay.target.messages.slice(3).filter(message => message.role !== 'assistant')).toEqual(modernIds.map((id, index) => ({
    role: 'tool', tool_call_id: id, content: `"MODERN_${index}"`,
  })));
});
