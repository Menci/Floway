import { expect, test } from 'vitest';

import { computeAnthropicMessagesTurnDigest } from '../../src/protocols/anthropic-messages/as-source/round-trip.ts';
import { computeGeminiGenerateContentTurnDigest } from '../../src/protocols/gemini-generate-content/as-source/round-trip.ts';
import { computeOpenAIChatCompletionsTurnDigest } from '../../src/protocols/openai-chat-completions/as-source/round-trip.ts';
import { computeOpenAIResponsesTurnDigest } from '../../src/protocols/openai-responses/as-source/round-trip.ts';
import { hashRoundTripContent } from '../../src/round-trip/hash.ts';
import type { AssistantTurnProtocol, InputAssistantTurnFor } from '../../src/round-trip/input-assistant-turn.ts';
import type { ReferenceableInputAssistantTurnFor } from '../../src/round-trip/reference/assistant-turn-types.ts';
import { ContentReference } from '../../src/round-trip/reference/types.ts';
import { ROUND_TRIP_SIDECAR_VERSION, encodeRoundTripSidecar } from '../../src/round-trip/sidecar.ts';
import { createTestSidecarCodec } from '../round-trip/sidecar-codec.ts';
import { expectTrip } from '../trip.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentRequest } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesRequestPayloadEx } from '@floway-dev/protocols/openai-responses';
import {
  routeAnthropicMessagesViaGeminiGenerateContent,
  routeAnthropicMessagesViaOpenAIChatCompletions,
  routeAnthropicMessagesViaOpenAIResponses,
  routeGeminiGenerateContentViaAnthropicMessages,
  routeGeminiGenerateContentViaOpenAIChatCompletions,
  routeGeminiGenerateContentViaOpenAIResponses,
  routeOpenAIChatCompletionsViaAnthropicMessages,
  routeOpenAIChatCompletionsViaGeminiGenerateContent,
  routeOpenAIChatCompletionsViaOpenAIResponses,
  routeOpenAIResponsesViaAnthropicMessages,
  routeOpenAIResponsesViaGeminiGenerateContent,
  routeOpenAIResponsesViaOpenAIChatCompletions,
} from '@floway-dev/translate';

const context = { sidecarCodec: createTestSidecarCodec('test-codec-scope'), fallbackMaxOutputTokens: undefined };
const chat = (carrier: string, text = 'answer'): OpenAIChatCompletionsPayloadEx => {
  const message: OpenAIChatCompletionsAssistantMessageEx = { role: 'assistant', content: text, reasoning_details: [{ type: 'reasoning.encrypted', data: carrier }] };
  return { model: 'source', stream: true, messages: [message] };
};
const messages = (carrier: string): AnthropicMessagesPayload => ({ model: 'source', max_tokens: 16, stream: true, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'answer' }, { type: 'redacted_thinking', data: carrier }] }] });
const responses = (carrier: string): OpenAIResponsesRequestPayloadEx => ({ model: 'source', stream: true, input: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] }, { type: 'reasoning', id: 'carrier', summary: [], encrypted_content: carrier }] });
const gemini = (carrier: string): GeminiGenerateContentRequest => ({ model: 'model', contents: [{ role: 'model', parts: [{ text: 'answer', thoughtSignature: carrier }] }] });

const turnDigest = async (source: AssistantTurnProtocol) => source === 'openaiChatCompletions'
  ? await computeOpenAIChatCompletionsTurnDigest({ role: 'assistant', content: 'answer' })
  : source === 'anthropicMessages'
    ? await computeAnthropicMessagesTurnDigest([{ role: 'assistant', content: [{ type: 'text', text: 'answer' }] }])
    : source === 'openaiResponses'
      ? await computeOpenAIResponsesTurnDigest([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] }])
      : await computeGeminiGenerateContentTurnDigest([{ role: 'model', parts: [{ text: 'answer' }] }]);

const nativeTurn = (target: AssistantTurnProtocol, text = 'restored'): InputAssistantTurnFor<AssistantTurnProtocol> => target === 'openaiChatCompletions'
  ? { role: 'assistant', content: text }
  : target === 'anthropicMessages'
    ? { role: 'assistant', content: [{ type: 'text', text, citations: [] }] }
    : target === 'openaiResponses'
      ? [{ type: 'message', role: 'assistant', content: text }]
      : [{ role: 'model', parts: [{ text }] }];

const cases = [
  { source: 'openaiChatCompletions', target: 'anthropicMessages', run: (carrier: string) => routeOpenAIChatCompletionsViaAnthropicMessages(chat(carrier), context) },
  { source: 'openaiChatCompletions', target: 'openaiResponses', run: (carrier: string) => routeOpenAIChatCompletionsViaOpenAIResponses(chat(carrier), context) },
  { source: 'openaiChatCompletions', target: 'geminiGenerateContent', run: (carrier: string) => routeOpenAIChatCompletionsViaGeminiGenerateContent(chat(carrier), context) },
  { source: 'anthropicMessages', target: 'openaiChatCompletions', run: (carrier: string) => routeAnthropicMessagesViaOpenAIChatCompletions(messages(carrier), context) },
  { source: 'anthropicMessages', target: 'openaiResponses', run: (carrier: string) => routeAnthropicMessagesViaOpenAIResponses(messages(carrier), context) },
  { source: 'anthropicMessages', target: 'geminiGenerateContent', run: (carrier: string) => routeAnthropicMessagesViaGeminiGenerateContent(messages(carrier), context) },
  { source: 'openaiResponses', target: 'anthropicMessages', run: (carrier: string) => routeOpenAIResponsesViaAnthropicMessages(responses(carrier), context) },
  { source: 'openaiResponses', target: 'openaiChatCompletions', run: (carrier: string) => routeOpenAIResponsesViaOpenAIChatCompletions(responses(carrier), context) },
  { source: 'openaiResponses', target: 'geminiGenerateContent', run: (carrier: string) => routeOpenAIResponsesViaGeminiGenerateContent(responses(carrier), context) },
  { source: 'geminiGenerateContent', target: 'anthropicMessages', run: (carrier: string) => routeGeminiGenerateContentViaAnthropicMessages(gemini(carrier), context) },
  { source: 'geminiGenerateContent', target: 'openaiChatCompletions', run: (carrier: string) => routeGeminiGenerateContentViaOpenAIChatCompletions(gemini(carrier), context) },
  { source: 'geminiGenerateContent', target: 'openaiResponses', run: (carrier: string) => routeGeminiGenerateContentViaOpenAIResponses(gemini(carrier), context) },
] as const;
// Reference hydration does not depend on the source/target pair, so one case per target protocol covers all four targets.
const hydrationCases = [
  ...cases.filter(({ source }) => source === 'geminiGenerateContent'),
  cases.find(({ source, target }) => source === 'openaiChatCompletions' && target === 'geminiGenerateContent')!,
];

test.each(cases)('receives recognized $source history via $target', async ({ source, target, run }) => {
  const native = nativeTurn(target);
  const carrier = await encodeRoundTripSidecar(createTestSidecarCodec(), { v: 1, source, target, targetTurn: native, sourceTurnDigest: await turnDigest(source) });
  const trip = expectTrip(await run(carrier));
  expect('input' in trip.target ? trip.target.input : 'contents' in trip.target ? trip.target.contents : trip.target.messages)
    .toEqual(target === 'openaiResponses' || target === 'geminiGenerateContent' ? native : [native]);
});

test.each(hydrationCases)('hydrates $source text references before restoring $target history', async ({ source, target, run }) => {
  const reference = new ContentReference('text', [[0, 0, 3]]);
  const targetTurn: ReferenceableInputAssistantTurnFor<AssistantTurnProtocol, ContentReference> = target === 'openaiChatCompletions'
    ? { role: 'assistant', content: reference }
    : target === 'anthropicMessages'
      ? { role: 'assistant', content: [{ type: 'text', text: reference, citations: [] }] }
      : target === 'openaiResponses'
        ? [{ type: 'message', role: 'assistant', content: reference }]
        : [{ role: 'model', parts: [{ text: reference }] }];
  const carrier = await encodeRoundTripSidecar(createTestSidecarCodec(), {
    v: 1, source, target, targetTurn, referencedContentHashes: [await hashRoundTripContent('answer')], sourceTurnDigest: await turnDigest(source),
  });
  const trip = expectTrip(await run(carrier));
  const native = nativeTurn(target, 'ans');
  expect('input' in trip.target ? trip.target.input : 'contents' in trip.target ? trip.target.contents : trip.target.messages)
    .toEqual(target === 'openaiResponses' || target === 'geminiGenerateContent' ? native : [native]);
});

test('hydrates a native JSON field from a replayed GenerateContent argument candidate', async () => {
  const args = { x: 1 };
  const reference = new ContentReference('json', [0]);
  const targetTurn: ReferenceableInputAssistantTurnFor<'anthropicMessages', ContentReference> = { role: 'assistant', content: [{ type: 'tool_use', id: 'native-call', name: 'native-tool', input: reference }] };
  const checkMaterial = { contents: [{ inlineData: [], functionCall: [{ name: 'lookup', args }] }] };
  const carrier = await encodeRoundTripSidecar(createTestSidecarCodec(), {
    v: 1,
    source: 'geminiGenerateContent',
    target: 'anthropicMessages', targetTurn,
    referencedContentHashes: [await hashRoundTripContent(JSON.stringify(args))],
    sourceTurnDigest: await hashRoundTripContent(JSON.stringify(checkMaterial)),
  });
  const trip = expectTrip(await routeGeminiGenerateContentViaAnthropicMessages({ model: 'model', contents: [{ role: 'model', parts: [{ functionCall: { name: 'lookup', args }, thoughtSignature: carrier }] }] }, context));
  expect(trip.target.messages).toEqual([{ role: 'assistant', content: [{ type: 'tool_use', id: 'native-call', name: 'native-tool', input: args }] }]);
});

test('exposes an authenticated missing reference as an internal error after replay verification', async () => {
  const carrier = await encodeRoundTripSidecar(createTestSidecarCodec(), {
    v: 1,
    source: 'openaiChatCompletions',
    target: 'anthropicMessages',
    targetTurn: { role: 'assistant', content: [{ type: 'text', text: new ContentReference('text', [0]), citations: [] }] },
    referencedContentHashes: [await hashRoundTripContent('missing')],
    sourceTurnDigest: await turnDigest('openaiChatCompletions'),
  });
  await expect(cases[0].run(carrier)).rejects.toThrow('missing-reference');
});

test.each(['different codec scope', 'changed sidecar handle', 'changed replay'] as const)('uses ordinary translation for %s', async failure => {
  const codec = createTestSidecarCodec(failure === 'different codec scope' ? 'other-scope' : 'test-codec-scope');
  const native: InputAssistantTurnFor<'anthropicMessages'> = { role: 'assistant', content: [{ type: 'text', text: 'restored', citations: [] }] };
  const encoded = await encodeRoundTripSidecar(codec, { v: 1, source: 'openaiChatCompletions', target: 'anthropicMessages', targetTurn: native, sourceTurnDigest: await turnDigest('openaiChatCompletions') });
  const carrier = failure === 'changed sidecar handle' ? `${encoded.startsWith('A') ? 'B' : 'A'}${encoded.slice(1)}` : encoded;
  const text = failure === 'changed replay' ? 'edited' : 'answer';
  const trip = expectTrip(await routeOpenAIChatCompletionsViaAnthropicMessages(chat(carrier, text), context));
  expect(trip.target.messages).toEqual([{ role: 'assistant', content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] }]);
});

test('preserves ordinary GenerateContent null-argument handling', async () => {
  const payload: GeminiGenerateContentRequest = { ...JSON.parse('{"contents":[{"role":"model","parts":[{"functionCall":{"name":"lookup","args":null}}]}]}'), model: 'model' };
  const chatTrip = expectTrip(await routeGeminiGenerateContentViaOpenAIChatCompletions(payload, context));
  expect(chatTrip.target.messages).toMatchObject([
    { role: 'assistant', tool_calls: [{ function: { name: 'lookup', arguments: 'null' } }] },
  ]);
  const responsesTrip = expectTrip(await routeGeminiGenerateContentViaOpenAIResponses(payload, context));
  expect(responsesTrip.target.input).toMatchObject([
    { type: 'function_call', name: 'lookup', arguments: 'null' },
  ]);
  const messagesTrip = expectTrip(await routeGeminiGenerateContentViaAnthropicMessages(payload, context));
  // ProtoJSON null remains the source value instead of being wrapped in an
  // invented argument object.
  expect(messagesTrip.target.messages).toMatchObject([
    { role: 'assistant', content: [{ type: 'tool_use', name: 'lookup', input: null }] },
  ]);
});

test('restores a v2 Chat Completions tool-call turn when the client omits null fields on replay', async () => {
  const toolCalls = [{ id: 'call_1', type: 'function' as const, function: { name: 'lookup', arguments: '{"x":1}' } }];
  const native: InputAssistantTurnFor<'anthropicMessages'> = {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'plan', signature: 'native-sig' },
      { type: 'tool_use', id: 'call_1', name: 'lookup', input: { x: 1 } },
    ],
  };
  const digest = await computeOpenAIChatCompletionsTurnDigest({
    role: 'assistant',
    content: null,
    refusal: null,
    function_call: null,
    tool_calls: toolCalls,
  });
  const carrier = await encodeRoundTripSidecar(createTestSidecarCodec(), {
    v: ROUND_TRIP_SIDECAR_VERSION,
    source: 'openaiChatCompletions',
    target: 'anthropicMessages',
    targetTurn: native,
    sourceTurnDigest: digest,
  });
  const replayedAssistant: OpenAIChatCompletionsAssistantMessageEx = {
    role: 'assistant',
    tool_calls: toolCalls,
    reasoning_details: [{ type: 'reasoning.encrypted', data: carrier }],
  };
  const trip = expectTrip(await routeOpenAIChatCompletionsViaAnthropicMessages({
    model: 'source',
    stream: true,
    messages: [replayedAssistant, { role: 'tool', tool_call_id: 'call_1', content: 'done' }],
  }, context));
  expect(trip.target.messages[0]).toEqual(native);
});
