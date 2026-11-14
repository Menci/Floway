import { test } from 'vitest';

import { fixtureFrames, type nativeResult } from './fixtures.ts';
import { partitionAnthropicMessagesTurns } from '../../src/protocols/anthropic-messages/as-source/conversation-turns.ts';
import { findAnthropicMessagesSidecarOccurrences } from '../../src/protocols/anthropic-messages/as-source/round-trip.ts';
import { findGeminiGenerateContentSidecarOccurrences } from '../../src/protocols/gemini-generate-content/as-source/round-trip.ts';
import { partitionOpenAIChatCompletionsTurns } from '../../src/protocols/openai-chat-completions/as-source/conversation-turns.ts';
import { findOpenAIChatCompletionsSidecarOccurrences } from '../../src/protocols/openai-chat-completions/as-source/round-trip.ts';
import { partitionOpenAIResponsesTurns } from '../../src/protocols/openai-responses/as-source/conversation-turns.ts';
import { findOpenAIResponsesSidecarOccurrences } from '../../src/protocols/openai-responses/as-source/round-trip.ts';
import { decodeRoundTripSidecar } from '../../src/round-trip/sidecar.ts';
import { requireJSONObject } from '../../src/shared/json/object.ts';
import type { TranslateInputError } from '../../src/types.ts';
import { createTestSidecarCodec } from '../round-trip/sidecar-codec.ts';
import { deepFreeze } from '../shared/deep-freeze.ts';
import { collect, iterate } from '../shared/iterables.ts';
import { expectTrip } from '../trip.ts';
import { collectAnthropicMessagesProtocolEventsToResult, type AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { collectGeminiGenerateContentProtocolEventsToResult, type GeminiGenerateContentContent, type GeminiGenerateContentRequest } from '@floway-dev/protocols/gemini-generate-content';
import { toOpenAIChatCompletionsInputAssistantMessage } from '@floway-dev/protocols/openai-chat-completions';
import { collectOpenAIChatCompletionsProtocolEventsToResult, type OpenAIChatCompletionsAssistantMessageEx, type OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import { toOpenAIResponsesInputItems } from '@floway-dev/protocols/openai-responses';
import { collectOpenAIResponsesProtocolEventsToResult, type CanonicalOpenAIResponsesInputItem, type CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { assert, assertEquals } from '@floway-dev/test-utils';
import { routeAnthropicMessagesViaOpenAIChatCompletions, routeAnthropicMessagesViaOpenAIResponses, routeOpenAIChatCompletionsViaAnthropicMessages, routeOpenAIChatCompletionsViaOpenAIResponses, routeGeminiGenerateContentViaAnthropicMessages, routeGeminiGenerateContentViaOpenAIChatCompletions, routeGeminiGenerateContentViaOpenAIResponses, routeOpenAIResponsesViaAnthropicMessages, routeOpenAIResponsesViaOpenAIChatCompletions } from '@floway-dev/translate';

const schema = { type: 'object' as const, properties: { x: { type: 'string' } } };
const formatSchema = { type: 'object', properties: { y: { type: 'string' } } };

const responses: CanonicalOpenAIResponsesPayload = {
  model: 'm',
  stream: true,
  input: [
    { type: 'reasoning', id: 'rs1', summary: [{ type: 'summary_text', text: 'thought' }] },
    { type: 'message', role: 'user', content: 'hi' },
  ],
  tools: [{ type: 'function', name: 'f', parameters: schema }],
  text: { format: { type: 'json_schema', name: 'f', schema: formatSchema } },
  metadata: { nested: 'x' },
};
const chat: OpenAIChatCompletionsPayload = {
  model: 'm',
  stream: true,
  messages: [
    { role: 'assistant', content: 'hello', reasoning_text: 'thought' } as OpenAIChatCompletionsAssistantMessageEx,
    { role: 'user', content: 'hi' },
  ],
  tools: [{ type: 'function', function: { name: 'f', parameters: schema } }],
  response_format: { type: 'json_schema', json_schema: { name: 'f', schema: formatSchema } },
  metadata: { nested: 'x' },
  stop: ['END'],
  tool_choice: 'auto',
};
const anthropic: AnthropicMessagesPayload = {
  model: 'm', max_tokens: 16, stream: true,
  messages: [{ role: 'user', content: 'hi' }],
  tools: [{ name: 'f', input_schema: schema }],
  output_config: { format: { type: 'json_schema', schema: formatSchema } },
  stop_sequences: ['END'],
  metadata: { user_id: 'u', extension: 'retained' } as AnthropicMessagesPayload['metadata'],
};
const gemini: GeminiGenerateContentRequest = {
  model: 'model',
  contents: [
    { role: 'model', parts: [{ functionCall: { name: 'f', args: { nested: { value: 'x' } } } }] },
    { role: 'user', parts: [{ text: 'hi' }] },
  ],
  tools: [{ functionDeclarations: [{ name: 'f', parameters: schema }] }],
  generationConfig: { responseSchema: formatSchema, stopSequences: ['END'], maxOutputTokens: 16 },
};

type Protocol = 'openai-chat-completions' | 'openai-responses' | 'anthropic-messages' | 'gemini-generate-content';
const codecScope = 'test-codec-scope';

const returnedTrips: { a: Protocol; b: Protocol; trip: (codecScope: string) => Promise<TranslateInputError | { type: 'trip'; events: (frames: AsyncIterable<any>) => AsyncIterable<any> }> }[] = [
  { a: 'openai-responses', b: 'openai-chat-completions', trip: codecScope => routeOpenAIResponsesViaOpenAIChatCompletions(responses, { sidecarCodec: createTestSidecarCodec(codecScope) }) },
  { a: 'openai-responses', b: 'anthropic-messages', trip: codecScope => routeOpenAIResponsesViaAnthropicMessages(responses, { sidecarCodec: createTestSidecarCodec(codecScope) }) },
  { a: 'openai-chat-completions', b: 'openai-responses', trip: codecScope => routeOpenAIChatCompletionsViaOpenAIResponses(chat, { sidecarCodec: createTestSidecarCodec(codecScope) }) },
  { a: 'openai-chat-completions', b: 'anthropic-messages', trip: codecScope => routeOpenAIChatCompletionsViaAnthropicMessages(chat, { sidecarCodec: createTestSidecarCodec(codecScope) }) },
  { a: 'anthropic-messages', b: 'openai-responses', trip: codecScope => routeAnthropicMessagesViaOpenAIResponses(anthropic, { sidecarCodec: createTestSidecarCodec(codecScope) }) },
  { a: 'anthropic-messages', b: 'openai-chat-completions', trip: codecScope => routeAnthropicMessagesViaOpenAIChatCompletions(anthropic, { sidecarCodec: createTestSidecarCodec(codecScope) }) },
  { a: 'gemini-generate-content', b: 'openai-responses', trip: codecScope => routeGeminiGenerateContentViaOpenAIResponses(gemini, { sidecarCodec: createTestSidecarCodec(codecScope) }) },
  { a: 'gemini-generate-content', b: 'openai-chat-completions', trip: codecScope => routeGeminiGenerateContentViaOpenAIChatCompletions(gemini, { sidecarCodec: createTestSidecarCodec(codecScope) }) },
  { a: 'gemini-generate-content', b: 'anthropic-messages', trip: codecScope => routeGeminiGenerateContentViaAnthropicMessages(gemini, { sidecarCodec: createTestSidecarCodec(codecScope), fallbackMaxOutputTokens: 16 }) },
] as const;

const protocolKeys = {
  'openai-chat-completions': 'openaiChatCompletions',
  'openai-responses': 'openaiResponses',
  'anthropic-messages': 'anthropicMessages',
  'gemini-generate-content': 'geminiGenerateContent',
} as const;

type AssistantTurn =
  | { protocol: 'openai-responses'; turn: CanonicalOpenAIResponsesInputItem[] }
  | { protocol: 'openai-chat-completions'; turn: OpenAIChatCompletionsAssistantMessageEx }
  | { protocol: 'anthropic-messages'; turn: Extract<AnthropicMessagesPayload['messages'][number], { role: 'assistant' }> }
  | { protocol: 'gemini-generate-content'; turn: GeminiGenerateContentContent[] };

const collectAssistantTurn = async (protocol: Protocol, frames: Parameters<typeof nativeResult>[1]): Promise<AssistantTurn> => {
  const events = iterate(frames);
  if (protocol === 'openai-responses') {
    const result = await collectOpenAIResponsesProtocolEventsToResult(events);
    return { protocol, turn: toOpenAIResponsesInputItems(result.output) };
  }
  if (protocol === 'openai-chat-completions') {
    const result = await collectOpenAIChatCompletionsProtocolEventsToResult(events);
    assert(result.choices[0] !== undefined);
    return { protocol, turn: toOpenAIChatCompletionsInputAssistantMessage(result.choices[0].message) };
  }
  if (protocol === 'anthropic-messages') {
    const result = await collectAnthropicMessagesProtocolEventsToResult(events);
    return {
      protocol,
      turn: {
        role: 'assistant',
        content: result.content.map(block => block.type === 'tool_use' ? { ...block, input: requireJSONObject(block.input) } : block),
      },
    };
  }
  const result = await collectGeminiGenerateContentProtocolEventsToResult(events);
  const content = result.candidates?.[0]?.content;
  assert(content !== undefined);
  return { protocol, turn: [content] };
};

const assistantText = (assistant: AssistantTurn): string => {
  if (assistant.protocol === 'openai-responses') return assistant.turn.flatMap(item => item.type === 'message'
    ? typeof item.content === 'string' ? [item.content] : item.content.flatMap(part => part.type === 'output_text' || part.type === 'input_text' ? [part.text] : [])
    : []).join('');
  if (assistant.protocol === 'openai-chat-completions') return typeof assistant.turn.content === 'string' ? assistant.turn.content : '';
  if (assistant.protocol === 'anthropic-messages') return typeof assistant.turn.content === 'string' ? assistant.turn.content
    : assistant.turn.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
  return assistant.turn.flatMap(content => content.parts?.flatMap(part => !part.thought && typeof part.text === 'string' ? [part.text] : []) ?? []).join('');
};

const sidecarPayload = (assistant: AssistantTurn): string | undefined => {
  const candidates = assistant.protocol === 'openai-responses' ? findOpenAIResponsesSidecarOccurrences(assistant.turn)
    : assistant.protocol === 'openai-chat-completions' ? findOpenAIChatCompletionsSidecarOccurrences(assistant.turn)
      : assistant.protocol === 'anthropic-messages' ? findAnthropicMessagesSidecarOccurrences([assistant.turn])
        : findGeminiGenerateContentSidecarOccurrences(assistant.turn);
  assertEquals(candidates.length, 1);
  return candidates[0].data;
};

const moveCarrierBeforeBody = (assistant: AssistantTurn, carrier: string): AssistantTurn => {
  if (assistant.protocol === 'openai-responses') {
    const index = assistant.turn.findIndex(item => item.type === 'reasoning' && item.encrypted_content === carrier);
    assert(index > 0);
    return { ...assistant, turn: [assistant.turn[index], ...assistant.turn.filter((_, itemIndex) => itemIndex !== index)] };
  }
  if (assistant.protocol === 'openai-chat-completions') {
    const details = assistant.turn.reasoning_details;
    assert(Array.isArray(details));
    const index = details.findIndex(detail => typeof detail === 'object' && detail !== null && 'data' in detail && detail.data === carrier);
    assert(index > 0);
    return { ...assistant, turn: { ...assistant.turn, reasoning_details: [details[index], ...details.filter((_, detailIndex) => detailIndex !== index)] } };
  }
  if (assistant.protocol === 'anthropic-messages') {
    const content = assistant.turn.content;
    assert(Array.isArray(content));
    const index = content.findIndex(block => block.type === 'redacted_thinking' && block.data === carrier);
    assert(index > 0);
    return { ...assistant, turn: { ...assistant.turn, content: [content[index], ...content.filter((_, blockIndex) => blockIndex !== index)] } };
  }
  return {
    ...assistant, turn: assistant.turn.map(content => {
      const parts = content.parts;
      if (parts === undefined) return content;
      const index = parts.findIndex(part => part.thoughtSignature === carrier);
      if (index < 0) return content;
      assert(index > 0);
      return { ...content, parts: [parts[index], ...parts.filter((_, partIndex) => partIndex !== index)] };
    }),
  };
};

type TargetPayload =
  | { protocol: 'openai-responses'; payload: CanonicalOpenAIResponsesPayload }
  | { protocol: 'openai-chat-completions'; payload: OpenAIChatCompletionsPayload }
  | { protocol: 'anthropic-messages'; payload: AnthropicMessagesPayload };

const replayAssistantTurn = async (assistant: AssistantTurn, target: Protocol): Promise<TargetPayload> => {
  if (assistant.protocol === 'openai-responses') {
    const request = { ...responses, input: [...assistant.turn, { type: 'message' as const, role: 'user' as const, content: 'next question' }] };
    if (target === 'openai-chat-completions') {
      return { protocol: 'openai-chat-completions', payload: (expectTrip(await routeOpenAIResponsesViaOpenAIChatCompletions(deepFreeze(request), { sidecarCodec: createTestSidecarCodec(codecScope) }))).target };
    }
    if (target === 'anthropic-messages') {
      return { protocol: 'anthropic-messages', payload: (expectTrip(await routeOpenAIResponsesViaAnthropicMessages(deepFreeze(request), { sidecarCodec: createTestSidecarCodec(codecScope) }))).target };
    }
  }
  if (assistant.protocol === 'openai-chat-completions') {
    const request = { ...chat, messages: [assistant.turn, { role: 'user' as const, content: 'next question' }] };
    if (target === 'openai-responses') {
      return { protocol: 'openai-responses', payload: (expectTrip(await routeOpenAIChatCompletionsViaOpenAIResponses(deepFreeze(request), { sidecarCodec: createTestSidecarCodec(codecScope) }))).target };
    }
    if (target === 'anthropic-messages') {
      return { protocol: 'anthropic-messages', payload: (expectTrip(await routeOpenAIChatCompletionsViaAnthropicMessages(deepFreeze(request), { sidecarCodec: createTestSidecarCodec(codecScope) }))).target };
    }
  }
  if (assistant.protocol === 'anthropic-messages') {
    const request = { ...anthropic, messages: [assistant.turn, { role: 'user' as const, content: 'next question' }] };
    if (target === 'openai-responses') {
      return { protocol: 'openai-responses', payload: (expectTrip(await routeAnthropicMessagesViaOpenAIResponses(deepFreeze(request), { sidecarCodec: createTestSidecarCodec(codecScope) }))).target };
    }
    if (target === 'openai-chat-completions') {
      return { protocol: 'openai-chat-completions', payload: (expectTrip(await routeAnthropicMessagesViaOpenAIChatCompletions(deepFreeze(request), { sidecarCodec: createTestSidecarCodec(codecScope) }))).target };
    }
  }
  if (assistant.protocol === 'gemini-generate-content') {
    const request = { ...gemini, contents: [...assistant.turn, { role: 'user' as const, parts: [{ text: 'next question' }] }] };
    if (target === 'openai-responses') {
      return { protocol: 'openai-responses', payload: (expectTrip(await routeGeminiGenerateContentViaOpenAIResponses(deepFreeze(request), { sidecarCodec: createTestSidecarCodec(codecScope) }))).target };
    }
    if (target === 'openai-chat-completions') {
      return { protocol: 'openai-chat-completions', payload: (expectTrip(await routeGeminiGenerateContentViaOpenAIChatCompletions(deepFreeze(request), { sidecarCodec: createTestSidecarCodec(codecScope) }))).target };
    }
    if (target === 'anthropic-messages') {
      return { protocol: 'anthropic-messages', payload: (expectTrip(await routeGeminiGenerateContentViaAnthropicMessages(deepFreeze(request), { sidecarCodec: createTestSidecarCodec(codecScope), fallbackMaxOutputTokens: 16 }))).target };
    }
  }
  throw new Error(`Unsupported route: ${assistant.protocol} via ${target}`);
};
const targetAssistantTurn = (target: TargetPayload) => {
  if (target.protocol === 'openai-responses') return partitionOpenAIResponsesTurns(target.payload.input).find(turn => turn.role === 'assistant')?.items;
  if (target.protocol === 'openai-chat-completions') return partitionOpenAIChatCompletionsTurns(target.payload.messages).find(turn => turn.role === 'assistant')?.items[0];
  return partitionAnthropicMessagesTurns(target.payload.messages).find(turn => turn.role === 'assistant')?.items[0];
};

test.each(returnedTrips)('$a via $b returns generated content and a decodable sidecar through its public TranslateTrip', async ({ a, b, trip }) => {
  const codec = createTestSidecarCodec(codecScope);
  const translation = expectTrip(await trip(codecScope));
  const fixture = {
    text: ['return ', 'path'],
    thinking: ['upstream thought'],
    signature: 'native B encrypted content',
    tools: [{ name: 'lookup', id: 'native-call', args: { q: 'value' } }],
  };
  const frames = await collect(translation.events(iterate(deepFreeze(fixtureFrames(b, fixture)))));
  const assistant = await collectAssistantTurn(a, frames);
  assertEquals(assistantText(assistant), 'return path');

  const carrier = sidecarPayload(assistant);
  assert(typeof carrier === 'string');
  const sidecar = await decodeRoundTripSidecar(codec, protocolKeys[a], carrier);
  assert(sidecar !== undefined);
  assertEquals(sidecar.source, protocolKeys[a]);
  assertEquals(sidecar.target, protocolKeys[b]);
  assertEquals(sidecar.targetTurn, (await collectAssistantTurn(b, fixtureFrames(b, fixture))).turn);
  assert(sidecar.v > 0);
  assert(sidecar.sourceTurnDigest instanceof Uint8Array && sidecar.sourceTurnDigest.byteLength > 0);

  const replayed = await replayAssistantTurn(assistant, b);
  assertEquals(targetAssistantTurn(replayed), sidecar.targetTurn);

  const moved = moveCarrierBeforeBody(deepFreeze(assistant), carrier);
  assertEquals(targetAssistantTurn(await replayAssistantTurn(moved, b)), sidecar.targetTurn);
});

test('a Responses client sees its own declarations echoed on the response object', async () => {
  // The upstream states no tools of its own, so the response objects carry the
  // declarations the client asked with. A client that reads this field expects
  // its groups back, not the flattened names the request was written with.
  const declaration = { type: 'namespace' as const, name: 'public', description: '', tools: [{ type: 'function' as const, name: 'lookup', parameters: schema }] };
  const payload: CanonicalOpenAIResponsesPayload = {
    model: 'm',
    stream: true,
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    tools: [declaration],
    tool_choice: 'auto',
  };
  const trip = expectTrip(await routeOpenAIResponsesViaOpenAIChatCompletions(payload, { sidecarCodec: createTestSidecarCodec('test-codec-scope') }));
  const frames = await collect(trip.events(iterate(fixtureFrames('openai-chat-completions', {
    text: ['ok'], thinking: [], signature: '', tools: [],
  }))));

  const created = frames.find(frame => frame.type === 'event' && frame.event.type === 'response.created');
  assert(created?.type === 'event');
  const createdResponse = 'response' in created.event ? created.event.response : undefined;
  assertEquals(createdResponse?.tools, [declaration]);
  assertEquals(createdResponse?.tool_choice, 'auto');
});
