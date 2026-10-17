import { test } from 'vitest';

import { partitionAnthropicMessagesTurns } from '../../src/protocols/anthropic-messages/as-source/conversation-turns.ts';
import { collectAnthropicMessagesReplayCandidates, inspectAnthropicMessagesAssistantTurn } from '../../src/protocols/anthropic-messages/as-source/round-trip.ts';
import { collectGeminiGenerateContentReplayCandidates, inspectGeminiGenerateContentAssistantTurn } from '../../src/protocols/gemini-generate-content/as-source/round-trip.ts';
import { partitionOpenAIChatCompletionsTurns } from '../../src/protocols/openai-chat-completions/as-source/conversation-turns.ts';
import { collectOpenAIChatCompletionsReplayCandidates, inspectOpenAIChatCompletionsAssistantTurn } from '../../src/protocols/openai-chat-completions/as-source/round-trip.ts';
import { toOpenAIChatCompletionsInputAssistantTurn } from '../../src/protocols/openai-chat-completions/as-target/assistant-turn.ts';
import { partitionOpenAIResponsesTurns } from '../../src/protocols/openai-responses/as-source/conversation-turns.ts';
import { collectOpenAIResponsesReplayCandidates, inspectOpenAIResponsesAssistantTurn, verifyOpenAIResponsesReplayCheck } from '../../src/protocols/openai-responses/as-source/round-trip.ts';
import { toOpenAIResponsesInputAssistantTurn } from '../../src/protocols/openai-responses/as-target/assistant-turn.ts';
import { hashRoundTripContent } from '../../src/round-trip/replay-check.ts';
import { decodeRoundTripSidecar } from '../../src/round-trip/sidecar.ts';
import { hydrateAssistantTurn } from '../../src/round-trip/thin/hydrate.ts';
import { ThinReference } from '../../src/round-trip/thin/reference.ts';
import { requireJSONObject } from '../../src/shared/json/object.ts';
import { collect, iterate } from '../ir/helpers.ts';
import { fixtureFrames, type nativeResult } from '../ir/translation-cases.ts';
import { createTestSidecarCodec } from '../round-trip/sidecar-codec.ts';
import { collectAnthropicMessagesProtocolEventsToResult, type AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { collectGeminiGenerateContentProtocolEventsToResult, type GeminiGenerateContentContent, type GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import { collectOpenAIChatCompletionsProtocolEventsToResult, type OpenAIChatCompletionsAssistantMessageEx, type OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import { collectOpenAIResponsesProtocolEventsToResult, type CanonicalOpenAIResponsesInputItem, type CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { assert, assertEquals } from '@floway-dev/test-utils';
import { routeAnthropicMessages } from '@floway-dev/translate/anthropic-messages';
import { routeGeminiGenerateContent } from '@floway-dev/translate/gemini-generate-content';
import { routeOpenAIChatCompletions } from '@floway-dev/translate/openai-chat-completions';
import { routeOpenAIResponses } from '@floway-dev/translate/openai-responses';

const schema = { type: 'object' as const, properties: { x: { type: 'string' } } };
const formatSchema = { type: 'object', properties: { y: { type: 'string' } } };

const responses: CanonicalOpenAIResponsesPayload = {
  model: 'm',
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
  model: 'm', max_tokens: 16,
  messages: [{ role: 'user', content: 'hi' }],
  tools: [{ name: 'f', input_schema: schema }],
  output_config: { format: { type: 'json_schema', schema: formatSchema } },
  stop_sequences: ['END'],
  metadata: { user_id: 'u', extension: 'retained' } as AnthropicMessagesPayload['metadata'],
};
const gemini: GeminiGenerateContentPayload = {
  contents: [
    { role: 'model', parts: [{ functionCall: { name: 'f', args: { nested: { value: 'x' } } } }] },
    { role: 'user', parts: [{ text: 'hi' }] },
  ],
  tools: [{ functionDeclarations: [{ name: 'f', parameters: schema }] }],
  generationConfig: { responseSchema: formatSchema, stopSequences: ['END'], maxOutputTokens: 16 },
};

const objectsIn = (value: unknown): Set<object> => {
  const objects = new Set<object>();
  const visit = (current: unknown): void => {
    if (typeof current !== 'object' || current === null || objects.has(current)) return;
    objects.add(current);
    for (const child of Object.values(current)) visit(child);
  };
  visit(value);
  return objects;
};

const responsesRoute = routeOpenAIResponses(responses);
const chatRoute = routeOpenAIChatCompletions(chat);
const anthropicRoute = routeAnthropicMessages(anthropic);
const geminiRoute = routeGeminiGenerateContent(gemini);

const translations: Array<{ name: string; source: unknown; translate: () => Promise<unknown> }> = [
  { name: 'Responses to Chat Completions', source: responses, translate: async () => (await responsesRoute.viaOpenAIChatCompletions({ sidecarCodec: createTestSidecarCodec('test-codec-scope'), model: 'm' })).target },
  { name: 'Responses to Anthropic Messages', source: responses, translate: async () => (await responsesRoute.viaAnthropicMessages({ sidecarCodec: createTestSidecarCodec('test-codec-scope'), model: 'm', loadRemoteImage: async () => { throw new Error('Unexpected remote image'); } })).target },
  { name: 'Chat Completions to Responses', source: chat, translate: async () => (await chatRoute.viaOpenAIResponses({ sidecarCodec: createTestSidecarCodec('test-codec-scope'), model: 'm' })).target },
  { name: 'Chat Completions to Anthropic Messages', source: chat, translate: async () => (await chatRoute.viaAnthropicMessages({ sidecarCodec: createTestSidecarCodec('test-codec-scope'), model: 'm', loadRemoteImage: async () => { throw new Error('Unexpected remote image'); } })).target },
  { name: 'Anthropic Messages to Responses', source: anthropic, translate: async () => (await anthropicRoute.viaOpenAIResponses({ sidecarCodec: createTestSidecarCodec('test-codec-scope'), model: 'm' })).target },
  { name: 'Anthropic Messages to Chat Completions', source: anthropic, translate: async () => (await anthropicRoute.viaOpenAIChatCompletions({ sidecarCodec: createTestSidecarCodec('test-codec-scope'), model: 'm' })).target },
  { name: 'Gemini to Responses', source: gemini, translate: async () => (await geminiRoute.viaOpenAIResponses({ sidecarCodec: createTestSidecarCodec('test-codec-scope'), model: 'm' })).target },
  { name: 'Gemini to Chat Completions', source: gemini, translate: async () => (await geminiRoute.viaOpenAIChatCompletions({ sidecarCodec: createTestSidecarCodec('test-codec-scope'), model: 'm' })).target },
  { name: 'Gemini to Anthropic Messages', source: gemini, translate: async () => (await geminiRoute.viaAnthropicMessages({ sidecarCodec: createTestSidecarCodec('test-codec-scope'), model: 'm', fallbackMaxOutputTokens: 16 })).target },
];

test.each(translations)('$name owns its target payload without retaining source or prior target objects', async ({ source, translate }) => {
  const original = structuredClone(source);
  const first = await translate();
  const second = await translate();
  const sourceObjects = objectsIn(source);
  const firstObjects = objectsIn(first);
  const secondObjects = objectsIn(second);

  assertEquals(source, original);
  for (const object of firstObjects) assertEquals(sourceObjects.has(object), false);
  for (const object of secondObjects) {
    assertEquals(sourceObjects.has(object), false);
    assertEquals(firstObjects.has(object), false);
  }
});

type Protocol = 'openai-chat-completions' | 'openai-responses' | 'anthropic-messages' | 'gemini-generate-content';
const codecScope = 'test-codec-scope';

const returnedTrips: { a: Protocol; b: Protocol; trip: (codecScope: string) => Promise<{ events: (frames: AsyncIterable<any>) => AsyncIterable<any> }> }[] = [
  { a: 'openai-responses', b: 'openai-chat-completions', trip: codecScope => responsesRoute.viaOpenAIChatCompletions({ sidecarCodec: createTestSidecarCodec(codecScope), model: 'm' }) },
  { a: 'openai-responses', b: 'anthropic-messages', trip: codecScope => responsesRoute.viaAnthropicMessages({ sidecarCodec: createTestSidecarCodec(codecScope), model: 'm', loadRemoteImage: async () => null }) },
  { a: 'openai-chat-completions', b: 'openai-responses', trip: codecScope => chatRoute.viaOpenAIResponses({ sidecarCodec: createTestSidecarCodec(codecScope), model: 'm' }) },
  { a: 'openai-chat-completions', b: 'anthropic-messages', trip: codecScope => chatRoute.viaAnthropicMessages({ sidecarCodec: createTestSidecarCodec(codecScope), model: 'm', loadRemoteImage: async () => null }) },
  { a: 'anthropic-messages', b: 'openai-responses', trip: codecScope => anthropicRoute.viaOpenAIResponses({ sidecarCodec: createTestSidecarCodec(codecScope), model: 'm' }) },
  { a: 'anthropic-messages', b: 'openai-chat-completions', trip: codecScope => anthropicRoute.viaOpenAIChatCompletions({ sidecarCodec: createTestSidecarCodec(codecScope), model: 'm' }) },
  { a: 'gemini-generate-content', b: 'openai-responses', trip: codecScope => geminiRoute.viaOpenAIResponses({ sidecarCodec: createTestSidecarCodec(codecScope), model: 'm' }) },
  { a: 'gemini-generate-content', b: 'openai-chat-completions', trip: codecScope => geminiRoute.viaOpenAIChatCompletions({ sidecarCodec: createTestSidecarCodec(codecScope), model: 'm' }) },
  { a: 'gemini-generate-content', b: 'anthropic-messages', trip: codecScope => geminiRoute.viaAnthropicMessages({ sidecarCodec: createTestSidecarCodec(codecScope), model: 'm', fallbackMaxOutputTokens: 16 }) },
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
    return { protocol, turn: toOpenAIResponsesInputAssistantTurn(result.output) };
  }
  if (protocol === 'openai-chat-completions') {
    const result = await collectOpenAIChatCompletionsProtocolEventsToResult(events);
    assert(result.choices[0] !== undefined);
    return { protocol, turn: toOpenAIChatCompletionsInputAssistantTurn(result.choices[0].message) };
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
  const candidates = assistant.protocol === 'openai-responses' ? inspectOpenAIResponsesAssistantTurn(assistant.turn)
    : assistant.protocol === 'openai-chat-completions' ? inspectOpenAIChatCompletionsAssistantTurn(assistant.turn)
      : assistant.protocol === 'anthropic-messages' ? inspectAnthropicMessagesAssistantTurn([assistant.turn])
        : inspectGeminiGenerateContentAssistantTurn(assistant.turn);
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

const replayCandidates = (assistant: AssistantTurn) => {
  if (assistant.protocol === 'openai-responses') {
    const candidates = inspectOpenAIResponsesAssistantTurn(assistant.turn);
    assertEquals(candidates.length, 1);
    return collectOpenAIResponsesReplayCandidates(candidates[0].withoutSidecar());
  }
  if (assistant.protocol === 'openai-chat-completions') {
    const candidates = inspectOpenAIChatCompletionsAssistantTurn(assistant.turn);
    assertEquals(candidates.length, 1);
    return collectOpenAIChatCompletionsReplayCandidates(candidates[0].withoutSidecar());
  }
  if (assistant.protocol === 'anthropic-messages') {
    const candidates = inspectAnthropicMessagesAssistantTurn([assistant.turn]);
    assertEquals(candidates.length, 1);
    return collectAnthropicMessagesReplayCandidates(candidates[0].withoutSidecar());
  }
  const candidates = inspectGeminiGenerateContentAssistantTurn(assistant.turn);
  assertEquals(candidates.length, 1);
  return collectGeminiGenerateContentReplayCandidates(candidates[0].withoutSidecar());
};

type TargetPayload =
  | { protocol: 'openai-responses'; payload: CanonicalOpenAIResponsesPayload }
  | { protocol: 'openai-chat-completions'; payload: OpenAIChatCompletionsPayload }
  | { protocol: 'anthropic-messages'; payload: AnthropicMessagesPayload };

const replayAssistantTurn = async (assistant: AssistantTurn, target: Protocol): Promise<TargetPayload> => {
  if (assistant.protocol === 'openai-responses') {
    const route = routeOpenAIResponses({ ...responses, input: [...assistant.turn, { type: 'message', role: 'user', content: 'next question' }] });
    if (target === 'openai-chat-completions') return { protocol: target, payload: (await route.viaOpenAIChatCompletions({ sidecarCodec: createTestSidecarCodec(codecScope), model: 'm' })).target };
    if (target === 'anthropic-messages') return { protocol: target, payload: (await route.viaAnthropicMessages({ sidecarCodec: createTestSidecarCodec(codecScope), model: 'm', loadRemoteImage: async () => null })).target };
  }
  if (assistant.protocol === 'openai-chat-completions') {
    const route = routeOpenAIChatCompletions({ ...chat, messages: [assistant.turn, { role: 'user', content: 'next question' }] });
    if (target === 'openai-responses') return { protocol: target, payload: (await route.viaOpenAIResponses({ sidecarCodec: createTestSidecarCodec(codecScope), model: 'm' })).target };
    if (target === 'anthropic-messages') return { protocol: target, payload: (await route.viaAnthropicMessages({ sidecarCodec: createTestSidecarCodec(codecScope), model: 'm', loadRemoteImage: async () => null })).target };
  }
  if (assistant.protocol === 'anthropic-messages') {
    const route = routeAnthropicMessages({ ...anthropic, messages: [assistant.turn, { role: 'user', content: 'next question' }] });
    if (target === 'openai-responses') return { protocol: target, payload: (await route.viaOpenAIResponses({ sidecarCodec: createTestSidecarCodec(codecScope), model: 'm' })).target };
    if (target === 'openai-chat-completions') return { protocol: target, payload: (await route.viaOpenAIChatCompletions({ sidecarCodec: createTestSidecarCodec(codecScope), model: 'm' })).target };
  }
  if (assistant.protocol === 'gemini-generate-content') {
    const route = routeGeminiGenerateContent({ ...gemini, contents: [...assistant.turn, { role: 'user', parts: [{ text: 'next question' }] }] });
    if (target === 'openai-responses') return { protocol: target, payload: (await route.viaOpenAIResponses({ sidecarCodec: createTestSidecarCodec(codecScope), model: 'm' })).target };
    if (target === 'openai-chat-completions') return { protocol: target, payload: (await route.viaOpenAIChatCompletions({ sidecarCodec: createTestSidecarCodec(codecScope), model: 'm' })).target };
    if (target === 'anthropic-messages') return { protocol: target, payload: (await route.viaAnthropicMessages({ sidecarCodec: createTestSidecarCodec(codecScope), model: 'm', fallbackMaxOutputTokens: 16 })).target };
  }
  throw new Error(`Unsupported route: ${assistant.protocol} via ${target}`);
};

const targetAssistantTurn = (target: TargetPayload) => {
  if (target.protocol === 'openai-responses') return partitionOpenAIResponsesTurns(target.payload.input).find(turn => turn.role === 'assistant')?.items;
  if (target.protocol === 'openai-chat-completions') return partitionOpenAIChatCompletionsTurns(target.payload.messages).find(turn => turn.role === 'assistant')?.items[0];
  return partitionAnthropicMessagesTurns(target.payload.messages).find(turn => turn.role === 'assistant')?.items[0];
};

const referencesIn = (value: unknown): ThinReference[] => {
  if (value instanceof ThinReference) return [value];
  if (Array.isArray(value)) return value.flatMap(referencesIn);
  if (typeof value !== 'object' || value === null) return [];
  return Object.values(value).flatMap(referencesIn);
};

test.each(returnedTrips)('$a via $b returns generated content and a decodable sidecar through its public TranslateTrip', async ({ a, b, trip }) => {
  const codec = createTestSidecarCodec(codecScope);
  const translation = await trip(codecScope);
  const fixture = {
    text: ['return ', 'path'],
    thinking: ['upstream thought'],
    signature: 'native B encrypted content',
    tools: [{ name: 'lookup', id: 'native-call', args: { q: 'value' } }],
  };
  const frames = await collect(translation.events(iterate(fixtureFrames(b, fixture))));
  const assistant = await collectAssistantTurn(a, frames);
  assertEquals(assistantText(assistant), 'return path');

  const carrier = sidecarPayload(assistant);
  assert(typeof carrier === 'string');
  const sidecar = await decodeRoundTripSidecar(codec, protocolKeys[a], carrier);
  assert(sidecar !== undefined);
  assertEquals(sidecar.source, protocolKeys[a]);
  assertEquals(sidecar.target, protocolKeys[b]);
  const expected = (await collectAssistantTurn(b, fixtureFrames(b, fixture))).turn;
  const hydrated = await hydrateAssistantTurn(protocolKeys[b], replayCandidates(assistant), sidecar.assistantTurn, sidecar.referencedContents);
  assert(hydrated.ok);
  assertEquals(hydrated.turn, expected);
  assertEquals(sidecar.assistantTurn, expected);
  assertEquals(sidecar.referencedContents, undefined);
  assert(sidecar.replayCheck.version > 0);
  assert(sidecar.replayCheck.digest instanceof Uint8Array && sidecar.replayCheck.digest.byteLength > 0);

  const replayed = await replayAssistantTurn(assistant, b);
  assertEquals(targetAssistantTurn(replayed), hydrated.turn);

  const before = structuredClone(assistant);
  const moved = moveCarrierBeforeBody(assistant, carrier);
  assertEquals(assistant, before);
  assertEquals(targetAssistantTurn(await replayAssistantTurn(moved, b)), hydrated.turn);
});

test.each(returnedTrips)('$a via $b references a profitable native body through its public TranslateTrip', async ({ a, b, trip }) => {
  const translation = await trip(codecScope);
  const fixture = { text: ['A long native assistant body. '.repeat(20)] };
  const assistant = await collectAssistantTurn(a, await collect(translation.events(iterate(fixtureFrames(b, fixture)))));
  const carrier = sidecarPayload(assistant);
  assert(typeof carrier === 'string');
  const sidecar = await decodeRoundTripSidecar(createTestSidecarCodec(codecScope), protocolKeys[a], carrier);
  assert(sidecar !== undefined);
  assertEquals(sidecar.referencedContents?.length, 1);
  const references = referencesIn(sidecar.assistantTurn);
  assert(references.length > 0);
  assert(references.every(reference => Array.isArray(reference.parts) && reference.parts.every(part => part === 0)));
  const expected = (await collectAssistantTurn(b, fixtureFrames(b, fixture))).turn;
  const hydrated = await hydrateAssistantTurn(protocolKeys[b], replayCandidates(assistant), sidecar.assistantTurn, sidecar.referencedContents);
  assert(hydrated.ok);
  assertEquals(hydrated.turn, expected);
  assertEquals(targetAssistantTurn(await replayAssistantTurn(assistant, b)), expected);
});

const repartitionAssistantText = (assistant: AssistantTurn, pieces: string[]): AssistantTurn => {
  if (assistant.protocol === 'openai-responses') return {
    ...assistant,
    turn: assistant.turn.map(item => item.type !== 'message' ? item : { ...item, content: pieces.map(text => ({ type: 'output_text' as const, text })) }),
  };
  if (assistant.protocol === 'anthropic-messages') {
    assert(Array.isArray(assistant.turn.content));
    return { ...assistant, turn: { ...assistant.turn, content: [...pieces.map(text => ({ type: 'text' as const, text, citations: null })), ...assistant.turn.content.filter(block => block.type !== 'text')] } };
  }
  if (assistant.protocol === 'gemini-generate-content') return {
    ...assistant,
    turn: assistant.turn.map(content => ({ ...content, parts: [...pieces.map(text => ({ text })), ...(content.parts?.filter(part => part.text === undefined) ?? [])] })),
  };
  throw new Error('Chat scalar content has no part boundaries');
};

const boundaryTrips = returnedTrips.filter(({ a }) => a !== 'openai-chat-completions').flatMap(route => [
  { ...route, operation: 'split' as const },
  ...(route.a === 'anthropic-messages' && route.b === 'openai-responses' ? [{ ...route, operation: 'merge' as const }] : []),
  ...(route.a === 'gemini-generate-content' && route.b !== 'openai-chat-completions' ? [{ ...route, operation: 'IR merge' as const }] : []),
]);

test.each(boundaryTrips)('$a via $b restores actual canonical references across $operation text parts', async ({ a, b, trip, operation }) => {
  const left = `${'A distinct first native segment. '.repeat(12)}\ud83d`;
  const right = `\ude00${' A distinct second native segment. '.repeat(13)}`;
  const text = left + right;
  const fixture = { text: operation === 'split' ? [text] : [left, right] };
  const translation = await trip(codecScope);
  const assistant = await collectAssistantTurn(a, await collect(translation.events(iterate(fixtureFrames(b, fixture)))));
  const carrier = sidecarPayload(assistant);
  assert(typeof carrier === 'string');
  const sidecar = await decodeRoundTripSidecar(createTestSidecarCodec(codecScope), protocolKeys[a], carrier);
  assert(sidecar !== undefined);
  assertEquals(sidecar.referencedContents, [await hashRoundTripContent(text)]);
  const references = referencesIn(sidecar.assistantTurn);
  assert(references.length > 0);
  assertEquals(references.map(reference => reference.parts), operation !== 'split'
    ? [[[0, 0, left.length]], [[0, left.length, text.length]]]
    : [[0]]);
  if (operation !== 'split') assertEquals(replayCandidates(assistant), [text]);
  const replayedAssistant = repartitionAssistantText(assistant, operation === 'split' ? [left, right] : [text]);
  assertEquals(replayCandidates(replayedAssistant), [text]);
  const expected = (await collectAssistantTurn(b, fixtureFrames(b, fixture))).turn;
  const hydrated = await hydrateAssistantTurn(protocolKeys[b], replayCandidates(replayedAssistant), sidecar.assistantTurn, sidecar.referencedContents);
  assert(hydrated.ok);
  assertEquals(hydrated.turn, expected);
  assertEquals(targetAssistantTurn(await replayAssistantTurn(replayedAssistant, b)), expected);
});

test('Responses keeps separate message hashes when Messages blocks open separate IR message items', async () => {
  const left = 'First separate message. '.repeat(20);
  const right = 'Second separate message. '.repeat(20);
  const translation = await responsesRoute.viaAnthropicMessages({ sidecarCodec: createTestSidecarCodec(codecScope), model: 'm', loadRemoteImage: async () => null });
  const assistant = await collectAssistantTurn('openai-responses', await collect(translation.events(iterate(fixtureFrames('anthropic-messages', { text: [left, right] })))));
  assert(assistant.protocol === 'openai-responses');
  const inspection = inspectOpenAIResponsesAssistantTurn(assistant.turn);
  assertEquals(inspection.length, 1);
  const carrier = inspection[0].data;
  assert(typeof carrier === 'string');
  const sidecar = await decodeRoundTripSidecar(createTestSidecarCodec(codecScope), 'openaiResponses', carrier);
  assert(sidecar !== undefined);
  assertEquals(sidecar.referencedContents, [await hashRoundTripContent(left), await hashRoundTripContent(right)]);
  assertEquals(referencesIn(sidecar.assistantTurn).map(reference => reference.parts), [[0], [1]]);
  const messages = inspection[0].withoutSidecar().filter(item => item.type === 'message');
  assertEquals(messages.length, 2);
  assertEquals(await verifyOpenAIResponsesReplayCheck([{ ...messages[0], content: [{ type: 'output_text', text: left + right }] }], sidecar.replayCheck), false);
});

test('Gemini via Responses restores literal reasoning when optional thought text is not replayed', async () => {
  const fixture = {
    text: ['visible ', 'answer'],
    thinking: ['optional thought'],
    signature: 'native B encrypted content',
  };
  const firstTrip = await routeGeminiGenerateContent(gemini).viaOpenAIResponses({ sidecarCodec: createTestSidecarCodec(codecScope), model: 'm' });
  const frames = await collect(firstTrip.events(iterate(fixtureFrames('openai-responses', fixture))));
  const assistant = await collectAssistantTurn('gemini-generate-content', frames);
  if (assistant.protocol !== 'gemini-generate-content') throw new Error('Expected a Gemini assistant turn');
  const content = assistant.turn[0];
  if (content === undefined) throw new Error('Expected a Gemini model turn');
  const carrier = sidecarPayload(assistant);
  assert(typeof carrier === 'string');
  const sidecar = await decodeRoundTripSidecar(createTestSidecarCodec(codecScope), 'geminiGenerateContent', carrier);
  assert(sidecar?.target === 'openaiResponses');
  const reasoning = sidecar.assistantTurn.find(item => item.type === 'reasoning');
  const message = sidecar.assistantTurn.find(item => item.type === 'message');
  assert(reasoning?.type === 'reasoning' && message?.type === 'message' && Array.isArray(message.content));
  assertEquals(reasoning.summary[0]?.text, 'optional thought');
  assertEquals(message.content.flatMap(part => part.type === 'output_text' ? [part.text] : []).join(''), 'visible answer');

  const replayed = await replayAssistantTurn({
    protocol: 'gemini-generate-content',
    turn: [{ ...content, parts: content.parts?.filter(part => !(part.thought === true && typeof part.text === 'string')) }],
  }, 'openai-responses');
  const expected = await collectAssistantTurn('openai-responses', fixtureFrames('openai-responses', fixture));
  assertEquals(targetAssistantTurn(replayed), expected.turn);
});
