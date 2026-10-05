import { expect, test } from 'vitest';

import { translateToSourceEvents } from '../../src/gemini-generate-content-via-openai-chat-completions/events.ts';
import { translateGeminiGenerateContentViaOpenAIChatCompletions } from '../../src/gemini-generate-content-via-openai-chat-completions/translate.ts';
import { privateContext } from '../test-utils/assistant-message-private.ts';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import { collectGeminiGenerateContentProtocolEventsToResult, type GeminiGenerateContentContent } from '@floway-dev/protocols/gemini-generate-content';
import { OpenAIChatCompletionsAssistantMessagePrivate, type OpenAIChatCompletionsAssistantDelta, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

const sidecar = { upstreamProtocol: 'openaiChatCompletions' as const, textFieldOriginalName: 'reasoning_content' as const, extraFields: { reasoning_opaque: 'native' }, toolCallExtraFields: {} };
const chunk = (index: number, text?: string): OpenAIChatCompletionsStreamEvent => ({ id: 'chat', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index, delta: { [OpenAIChatCompletionsAssistantMessagePrivate]: text !== undefined ? { reasoningText: text } : { sidecar } } as OpenAIChatCompletionsAssistantDelta, finish_reason: null }] });

test('each thought delta is yielded before requesting the next upstream frame', async () => {
  let reads = 0;
  const stream = translateToSourceEvents((async function* () { reads++; yield eventFrame(chunk(0, 'A')); reads++; yield eventFrame(chunk(0, 'B')); yield doneFrame(); })(), privateContext());
  const first = await stream.next();
  expect(first.value).toEqual(eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ thought: true, text: 'A' }] } }] }));
  expect(reads).toBe(1);
  await stream.return(undefined);
});

test.each([false, true])('all reasoning text remains in one standalone signature with includeThoughts=%s', async includeThoughts => {
  const context = privateContext();
  const result = await collectGeminiGenerateContentProtocolEventsToResult(translateToSourceEvents((async function* () {
    yield eventFrame(chunk(0, 'A'));
    yield eventFrame({ ...chunk(0, 'B'), choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: null }] });
    yield eventFrame(chunk(0, 'B'));
    yield eventFrame(chunk(0));
    yield doneFrame();
  })(), context));
  const content = result.candidates![0].content;
  if (content?.parts === undefined) throw new Error('Expected collected content parts');
  expect(content.parts).toHaveLength(4);
  const carrier = content.parts.at(-1)!;
  expect(Object.keys(carrier)).toEqual(['thoughtSignature']);
  expect(await context.codec.unencapsulate(carrier.thoughtSignature)).toEqual({ reasoningText: 'AB', sidecar });
  const replay = { ...content, parts: content.parts.filter(part => part.thought !== true) };
  const trip = await translateGeminiGenerateContentViaOpenAIChatCompletions({ contents: [replay], generationConfig: { thinkingConfig: { includeThoughts } } }, { model: 'm', privateContext: context });
  expect((trip.target.messages[0] as import('@floway-dev/protocols/openai-chat-completions').OpenAIChatCompletionsAssistantMessage)[OpenAIChatCompletionsAssistantMessagePrivate]).toEqual({ reasoningText: 'AB', sidecar });
  expect(trip.target.messages[0].content).toBe('answer');
});

test('different candidates retain independent text and final signature payloads', async () => {
  const context = privateContext();
  const result = await collectGeminiGenerateContentProtocolEventsToResult(translateToSourceEvents((async function* () { yield eventFrame(chunk(0, 'A')); yield eventFrame(chunk(1, 'B')); yield eventFrame(chunk(0, 'C')); yield eventFrame(chunk(0)); yield eventFrame(chunk(1)); yield doneFrame(); })(), context));
  const states = await Promise.all(result.candidates!.map(candidate => context.codec.unencapsulate(candidate.content?.parts?.at(-1)?.thoughtSignature)));
  expect(states.map(state => state?.reasoningText)).toEqual(['AC', 'B']);
});

test('history ends each interval at its owned Part and ignores edited display thought text', async () => {
  const context = privateContext();
  const data = await context.codec.encapsulate({ reasoningText: 'original', sidecar });
  const other = await context.codec.encapsulate({ reasoningText: 'other', sidecar });
  const content: GeminiGenerateContentContent = { role: 'model', parts: [{ thoughtSignature: 'foreign' }, { text: 'edited', thought: true }, { text: 'answer', thoughtSignature: data }, { thoughtSignature: other }] };
  const trip = await translateGeminiGenerateContentViaOpenAIChatCompletions({ contents: [content] }, { model: 'm', privateContext: context });
  expect((trip.target.messages[0] as import('@floway-dev/protocols/openai-chat-completions').OpenAIChatCompletionsAssistantMessage)[OpenAIChatCompletionsAssistantMessagePrivate]).toEqual({ reasoningText: 'original', sidecar });
  expect(content.parts).toHaveLength(4);
  expect((trip.target.messages[1] as import('@floway-dev/protocols/openai-chat-completions').OpenAIChatCompletionsAssistantMessage)[OpenAIChatCompletionsAssistantMessagePrivate]).toEqual({ reasoningText: 'other', sidecar });
  expect(JSON.stringify(trip.target.messages)).toBe('[{"role":"assistant","content":"answer"},{"role":"assistant","content":null}]');
});

test('owned intervals span Contents while foreign tails retain their Content boundaries', async () => {
  const context = privateContext();
  const data = await context.codec.encapsulate({ reasoningText: 'original', sidecar });
  const contents: GeminiGenerateContentContent[] = [
    { role: 'model', parts: [{ text: 'A' }] },
    { role: 'model', parts: [{ text: 'B', thoughtSignature: data }, { text: 'ignored', thought: true }, { text: 'tail' }] },
    { role: 'model', parts: [{ text: 'next tail' }] },
    { role: 'user', parts: [{ text: 'continue' }] },
    { role: 'model', parts: [{ text: 'foreign', thoughtSignature: 'foreign' }] },
  ];
  const trip = await translateGeminiGenerateContentViaOpenAIChatCompletions({ contents }, { model: 'm', privateContext: context });
  expect(trip.target.messages).toEqual([
    { role: 'assistant', content: 'AB', [OpenAIChatCompletionsAssistantMessagePrivate]: { reasoningText: 'original', sidecar } },
    { role: 'assistant', content: 'tail' },
    { role: 'assistant', content: 'next tail' },
    { role: 'user', content: 'continue' },
    { role: 'assistant', content: 'foreign' },
  ]);
  expect(contents[1].parts![1]).toEqual({ text: 'ignored', thought: true });
});
