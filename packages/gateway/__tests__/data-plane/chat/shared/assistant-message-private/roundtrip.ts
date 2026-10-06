import { expect } from 'vitest';

import { extractOpenAIChatCompletionsPrivate } from '../../../../../src/data-plane/chat/openai-chat-completions/assistant-message-private/extract.ts';
import { restoreOpenAIChatCompletionsPrivateHistory } from '../../../../../src/data-plane/chat/openai-chat-completions/assistant-message-private/request.ts';
import { encodeOpenAIChatCompletionsPrivate } from '../../../../../src/data-plane/chat/openai-chat-completions/assistant-message-private/response.ts';
import { createOpenAIChatCompletionsPrivateCodec } from '../../../../../src/data-plane/chat/shared/assistant-message-private/codec.ts';
import { collectAnthropicMessagesProtocolEventsToResult, parseAnthropicMessagesStream, anthropicMessagesProtocolFrameToSSEFrame, type AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { parseSSEStream, eventFrame, type ProtocolFrame, type SseFrame } from '@floway-dev/protocols/common';
import { collectGeminiGenerateContentProtocolEventsToResult, reassembleGeminiGenerateContentEvents, geminiGenerateContentProtocolFrameToSSEFrame, type GeminiGenerateContentContent, type GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import { collectOpenAIChatCompletionsProtocolEventsToResult, parseOpenAIChatCompletionsStream, openaiChatCompletionsProtocolFrameToSSEFrame, type OpenAIChatCompletionsStreamEvent, type OpenAIChatCompletionsAssistantMessage, type OpenAIChatCompletionsPayload, type OpenAIChatCompletionsPrivateContext } from '@floway-dev/protocols/openai-chat-completions';
import { collectOpenAIResponsesProtocolEventsToResult, parseOpenAIResponsesStream, openaiResponsesProtocolFrameToSSEFrame, type OpenAIResponsesStreamEventEx, type CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';
import { translateAnthropicMessagesViaOpenAIChatCompletions, translateGeminiGenerateContentViaOpenAIChatCompletions, translateOpenAIResponsesViaOpenAIChatCompletions, translateOpenAIChatCompletionsViaAnthropicMessages, translateOpenAIChatCompletionsViaOpenAIResponses } from '@floway-dev/translate';

export const frames = async function* <T>(values: readonly T[]) { yield* values; };

export const sseBody = <T>(source: AsyncIterable<ProtocolFrame<T>>, format: (frame: ProtocolFrame<T>) => SseFrame | null): ReadableStream<Uint8Array> => {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) { controller.close(); return; }
      const frame = format(next.value);
      if (frame !== null) controller.enqueue(new TextEncoder().encode(`${frame.event === undefined ? '' : `event: ${frame.event}\n`}data: ${frame.data}\n\n`));
    },
  });
};

export const chatSse = (source: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>) => sseBody(source, frame => openaiChatCompletionsProtocolFrameToSSEFrame(frame, { includeUsageChunk: true }));
export const messagesSse = (source: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>) => sseBody(source, anthropicMessagesProtocolFrameToSSEFrame);
export const responsesSse = (source: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>) => sseBody(source, openaiResponsesProtocolFrameToSSEFrame);

export const collectChatHistory = async (source: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>) => (await collectOpenAIChatCompletionsProtocolEventsToResult(parseOpenAIChatCompletionsStream(chatSse(source)))).choices.map(choice => choice.message);
export const collectMessagesHistory = async (source: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>) => ({ role: 'assistant' as const, content: (await collectAnthropicMessagesProtocolEventsToResult(parseAnthropicMessagesStream(messagesSse(source)))).content });
export const collectResponsesHistory = async (source: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>) => (await collectOpenAIResponsesProtocolEventsToResult(parseOpenAIResponsesStream(responsesSse(source)))).output;

// A nullable response refusal and an omitted request refusal represent the same history.
export const chatHistory = (messages: OpenAIChatCompletionsAssistantMessage[]) => messages.map(message => {
  const { refusal, ...fields } = message;
  return JSON.parse(JSON.stringify({ ...fields, ...(refusal == null ? {} : { refusal }) })) as unknown;
});

export const context: OpenAIChatCompletionsPrivateContext = {
  preference: { textFieldName: 'reasoning', reasoningEncapsulationFormat: 'openrouter-reasoning_details' },
  codec: createOpenAIChatCompletionsPrivateCodec({ serverSecret: 'roundtrip-oracle' }),
};
const translationContext = { model: 'm', privateContext: context, loadRemoteImage: async () => { throw new Error('Unexpected fixture image'); } };
const parseGemini = async function* (body: ReadableStream<Uint8Array>) { for await (const frame of parseSSEStream(body)) yield eventFrame(JSON.parse(frame.data) as GeminiGenerateContentStreamEvent); };

export const assertChatViaMessagesRoundtrip = async (upstream: readonly ProtocolFrame<AnthropicMessagesStreamEventEx>[], editClientMessage?: (message: OpenAIChatCompletionsAssistantMessage) => void) => {
  const expected = await collectMessagesHistory(frames(upstream));
  const forward = await translateOpenAIChatCompletionsViaAnthropicMessages({ model: 'm', messages: [] }, translationContext);
  const downstream = encodeOpenAIChatCompletionsPrivate(forward.events(parseAnthropicMessagesStream(messagesSse(frames(upstream)))), context);
  const client = await collectOpenAIChatCompletionsProtocolEventsToResult(parseOpenAIChatCompletionsStream(chatSse(downstream)));
  editClientMessage?.(client.choices[0].message);
  const replay = await translateOpenAIChatCompletionsViaAnthropicMessages({ model: 'm', messages: [client.choices[0].message, { role: 'user', content: 'continue' }] }, translationContext);
  expect(replay.target.messages.slice(0, -1)).toEqual([expected]);
};

export const assertChatViaResponsesRoundtrip = async (upstream: readonly ProtocolFrame<OpenAIResponsesStreamEventEx>[], editClientMessage?: (message: OpenAIChatCompletionsAssistantMessage) => void) => {
  const expected = await collectResponsesHistory(frames(upstream));
  const forward = await translateOpenAIChatCompletionsViaOpenAIResponses({ model: 'm', messages: [] }, translationContext);
  const downstream = encodeOpenAIChatCompletionsPrivate(forward.events(parseOpenAIResponsesStream(responsesSse(frames(upstream)))), context);
  const client = await collectOpenAIChatCompletionsProtocolEventsToResult(parseOpenAIChatCompletionsStream(chatSse(downstream)));
  editClientMessage?.(client.choices[0].message);
  const replay = await translateOpenAIChatCompletionsViaOpenAIResponses({ model: 'm', messages: [client.choices[0].message, { role: 'user', content: 'continue' }] }, translationContext);
  expect(replay.target.input.slice(0, -1)).toEqual(expected);
};

export const assertChatUpstreamRoundtrip = async (protocol: 'anthropicMessages' | 'openaiResponses' | 'geminiGenerateContent', upstream: readonly ProtocolFrame<OpenAIChatCompletionsStreamEvent>[]) => {
  if (protocol === 'geminiGenerateContent') {
    await assertGeminiIntervalsRoundtrip([upstream]);
    return;
  }
  const expected = chatHistory(await collectChatHistory(frames(upstream)));
  const source = extractOpenAIChatCompletionsPrivate(parseOpenAIChatCompletionsStream(chatSse(frames(upstream))));
  let target: OpenAIChatCompletionsPayload;
  if (protocol === 'anthropicMessages') {
    const forward = await translateAnthropicMessagesViaOpenAIChatCompletions({ model: 'm', max_tokens: 10, messages: [] }, translationContext);
    const client = await collectAnthropicMessagesProtocolEventsToResult(parseAnthropicMessagesStream(messagesSse(forward.events(source))));
    target = (await translateAnthropicMessagesViaOpenAIChatCompletions({ model: 'm', max_tokens: 10, messages: [{ role: 'assistant', content: client.content }] }, translationContext)).target;
  } else {
    const forward = await translateOpenAIResponsesViaOpenAIChatCompletions({ model: 'm', input: [] }, translationContext);
    const client = await collectOpenAIResponsesProtocolEventsToResult(parseOpenAIResponsesStream(responsesSse(forward.events(source))));
    target = (await translateOpenAIResponsesViaOpenAIChatCompletions({ model: 'm', input: client.output as CanonicalOpenAIResponsesInputItem[] }, translationContext)).target;
  }
  restoreOpenAIChatCompletionsPrivateHistory(target);
  expect(chatHistory(target.messages as OpenAIChatCompletionsAssistantMessage[])).toEqual(expected);
};

export const assertGeminiIntervalsRoundtrip = async (
  upstreams: readonly (readonly ProtocolFrame<OpenAIChatCompletionsStreamEvent>[])[],
  editClientHistory?: (contents: GeminiGenerateContentContent[]) => void,
) => {
  const expected: OpenAIChatCompletionsAssistantMessage[] = [];
  const collected: GeminiGenerateContentContent[] = [];
  const chunks: GeminiGenerateContentContent[] = [];
  for (const upstream of upstreams) {
    expected.push(...await collectChatHistory(frames(upstream)));
    const forward = await translateGeminiGenerateContentViaOpenAIChatCompletions({ contents: [] }, translationContext);
    const source = extractOpenAIChatCompletionsPrivate(parseOpenAIChatCompletionsStream(chatSse(frames(upstream))));
    const events: ProtocolFrame<GeminiGenerateContentStreamEvent>[] = [];
    for await (const frame of parseGemini(sseBody(forward.events(source), geminiGenerateContentProtocolFrameToSSEFrame))) {
      events.push(frame);
      const client = await reassembleGeminiGenerateContentEvents(frames([frame.event]));
      if (client.candidates?.[0].content !== undefined) chunks.push(client.candidates[0].content);
    }
    const client = await collectGeminiGenerateContentProtocolEventsToResult(frames(events));
    collected.push(client.candidates![0].content!);
  }
  const merged: GeminiGenerateContentContent[] = [{ role: 'model', parts: collected.flatMap(content => content.parts!) }];
  for (const contents of [collected, chunks, merged]) {
    editClientHistory?.(contents);
    const { target } = await translateGeminiGenerateContentViaOpenAIChatCompletions({ contents }, translationContext);
    restoreOpenAIChatCompletionsPrivateHistory(target);
    expect(chatHistory(target.messages as OpenAIChatCompletionsAssistantMessage[])).toEqual(chatHistory(expected));
  }
};

export const assertResponsesIntervalsRoundtrip = async (upstreams: readonly (readonly ProtocolFrame<OpenAIChatCompletionsStreamEvent>[])[]) => {
  const expected: OpenAIChatCompletionsAssistantMessage[] = [];
  const input: CanonicalOpenAIResponsesInputItem[] = [];
  for (const upstream of upstreams) {
    expected.push(...await collectChatHistory(frames(upstream)));
    const forward = await translateOpenAIResponsesViaOpenAIChatCompletions({ model: 'm', input: [] }, translationContext);
    const source = extractOpenAIChatCompletionsPrivate(parseOpenAIChatCompletionsStream(chatSse(frames(upstream))));
    const client = await collectOpenAIResponsesProtocolEventsToResult(parseOpenAIResponsesStream(responsesSse(forward.events(source))));
    input.push(...client.output as CanonicalOpenAIResponsesInputItem[]);
  }
  const { target } = await translateOpenAIResponsesViaOpenAIChatCompletions({ model: 'm', input }, translationContext);
  restoreOpenAIChatCompletionsPrivateHistory(target);
  expect(chatHistory(target.messages as OpenAIChatCompletionsAssistantMessage[])).toEqual(chatHistory(expected));
};
