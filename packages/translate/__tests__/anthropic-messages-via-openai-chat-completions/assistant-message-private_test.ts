import { expect, test } from 'vitest';

import { createOpenAIChatCompletionsToAnthropicMessagesStreamState, translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents, translateToSourceEvents } from '../../src/anthropic-messages-via-openai-chat-completions/events.ts';
import { translateAnthropicMessagesViaOpenAIChatCompletions } from '../../src/anthropic-messages-via-openai-chat-completions/translate.ts';
import { privateContext } from '../test-utils/assistant-message-private.ts';
import { collectAnthropicMessagesProtocolEventsToResult, type AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import { OpenAIChatCompletionsAssistantMessagePrivate, type OpenAIChatCompletionsAssistantDelta, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

const sidecar = { upstreamProtocol: 'openaiChatCompletions' as const, textFieldOriginalName: 'reasoning_content' as const, extraFields: { reasoning_opaque: 'native' }, toolCallExtraFields: {} };
const chunk = (delta: OpenAIChatCompletionsAssistantDelta): OpenAIChatCompletionsStreamEvent => ({ id: 'chat', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: null }] });
const thought = (text?: string): OpenAIChatCompletionsAssistantDelta => ({ [OpenAIChatCompletionsAssistantMessagePrivate]: text !== undefined ? { reasoningText: text } : { sidecar } });

test('thinking/text/thinking stays live with separate native block lifecycles', () => {
  const state = createOpenAIChatCompletionsToAnthropicMessagesStreamState();
  expect(translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(chunk(thought('A')), state).at(-1)).toEqual({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'A' } });
  const text = translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(chunk({ content: 'answer' }), state);
  expect(text[1]).toEqual({ type: 'content_block_stop', index: 0 });
  expect(text.at(-1)).toEqual({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } });
  const later = translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(chunk(thought('B')), state);
  expect(later.at(-1)).toEqual({ type: 'content_block_delta', index: 2, delta: { type: 'thinking_delta', thinking: 'B' } });
});

test('parallel incomplete tool blocks close only at their own JSON boundary without buffering text', () => {
  const state = createOpenAIChatCompletionsToAnthropicMessagesStreamState();
  translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(chunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'f', arguments: '{' } }] }), state);
  const text = translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(chunk({ content: 'live' }), state);
  expect(text.some(event => event.type === 'content_block_stop')).toBe(false);
  translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(chunk({ tool_calls: [{ index: 1, id: 'b', function: { name: 'g', arguments: '{' } }] }), state);
  const earlier = translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(chunk({ tool_calls: [{ index: 0, function: { arguments: '}' } }] }), state);
  expect(earlier).toEqual([{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '}' } }, { type: 'content_block_stop', index: 0 }]);
});

test('final redacted carrier contains all readable text independently of display blocks', async () => {
  const context = privateContext();
  const result = await collectAnthropicMessagesProtocolEventsToResult(translateToSourceEvents((async function* () {
    yield eventFrame(chunk(thought('A')));
    yield eventFrame(chunk({ content: 'answer' }));
    yield eventFrame(chunk(thought('B')));
    yield eventFrame(chunk(thought()));
    yield doneFrame();
  })(), context));
  expect(result.content.map(block => block.type)).toEqual(['thinking', 'text', 'thinking', 'redacted_thinking']);
  expect(result.content[0]).toEqual({ type: 'thinking', thinking: 'A', signature: '' });
  const carrier = result.content.at(-1);
  if (carrier?.type !== 'redacted_thinking') throw new Error('Expected carrier');
  expect(await context.codec.unencapsulate(carrier.data)).toEqual({ reasoningText: 'AB', sidecar });
});

test('history accepts the first owned redacted block, discards others and ignores edited display text', async () => {
  const context = privateContext();
  const data = await context.codec.encapsulate({ reasoningText: 'original', sidecar });
  const other = await context.codec.encapsulate({ reasoningText: 'other', sidecar });
  const source: AnthropicMessagesPayload = {
    model: 'm', max_tokens: 1, messages: [{
      role: 'assistant', content: [
        { type: 'redacted_thinking', data: 'foreign' }, { type: 'thinking', thinking: 'edited', signature: 'foreign' },
        { type: 'text', text: 'answer' }, { type: 'redacted_thinking', data }, { type: 'redacted_thinking', data: other },
      ],
    }],
  };
  const trip = await translateAnthropicMessagesViaOpenAIChatCompletions(source, { model: 'm', privateContext: context });
  expect((trip.target.messages[0] as import('@floway-dev/protocols/openai-chat-completions').OpenAIChatCompletionsAssistantMessage)[OpenAIChatCompletionsAssistantMessagePrivate]).toEqual({ reasoningText: 'original', sidecar });
  expect(source.messages[0].content).toHaveLength(5);
});
