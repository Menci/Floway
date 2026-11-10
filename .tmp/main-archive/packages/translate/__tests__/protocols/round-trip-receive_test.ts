import { expect, test } from 'vitest';

import type { IRJSONObject } from '../../src/ir/types.ts';
import { computeAnthropicMessagesTurnDigest } from '../../src/protocols/anthropic-messages/as-source/round-trip.ts';
import { computeGeminiGenerateContentTurnDigest } from '../../src/protocols/gemini-generate-content/as-source/round-trip.ts';
import { computeOpenAIChatCompletionsTurnDigest } from '../../src/protocols/openai-chat-completions/as-source/round-trip.ts';
import { computeOpenAIResponsesTurnDigest } from '../../src/protocols/openai-responses/as-source/round-trip.ts';
import type { AssistantTurnFor } from '../../src/round-trip/assistant-turn.ts';
import type { ReferenceableAssistantTurnFor } from '../../src/round-trip/reference/assistant-turn.ts';
import { ContentReference } from '../../src/round-trip/reference/assistant-turn.ts';
import type { RoundTripProtocol } from '../../src/round-trip/sidecar.ts';
import { encodeRoundTripSidecar } from '../../src/round-trip/sidecar.ts';
import { hashRoundTripContent, replayMaterialsByType } from '../../src/round-trip/turn-digest.ts';
import { createTestSidecarCodec } from '../round-trip/sidecar-codec.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesRequestPayloadEx } from '@floway-dev/protocols/openai-responses';
import { routeAnthropicMessages } from '@floway-dev/translate/anthropic-messages';
import { routeGeminiGenerateContent } from '@floway-dev/translate/gemini-generate-content';
import { routeOpenAIChatCompletions } from '@floway-dev/translate/openai-chat-completions';
import { routeOpenAIResponses } from '@floway-dev/translate/openai-responses';

const context = { model: 'target', sidecarCodec: createTestSidecarCodec('test-codec-scope'), loadRemoteImage: async () => null, fallbackMaxOutputTokens: undefined };
const chat = (carrier: string, text = 'answer'): OpenAIChatCompletionsPayloadEx => {
  const message: OpenAIChatCompletionsAssistantMessageEx = { role: 'assistant', content: text, reasoning_details: [{ type: 'reasoning.encrypted', data: carrier }] };
  return { model: 'source', messages: [message] };
};
const messages = (carrier: string): AnthropicMessagesPayload => ({ model: 'source', max_tokens: 16, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'answer' }, { type: 'redacted_thinking', data: carrier }] }] });
const responses = (carrier: string): OpenAIResponsesRequestPayloadEx => ({ model: 'source', input: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] }, { type: 'reasoning', id: 'carrier', summary: [], encrypted_content: carrier }] });
const gemini = (carrier: string): GeminiGenerateContentPayload => ({ contents: [{ role: 'model', parts: [{ text: 'answer', thoughtSignature: carrier }] }] });

const turnDigest = async (source: RoundTripProtocol) => source === 'openaiChatCompletions'
  ? await computeOpenAIChatCompletionsTurnDigest({ role: 'assistant', content: 'answer' })
  : source === 'anthropicMessages'
    ? await computeAnthropicMessagesTurnDigest([{ role: 'assistant', content: [{ type: 'text', text: 'answer' }] }])
    : source === 'openaiResponses'
      ? await computeOpenAIResponsesTurnDigest([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] }])
      : await computeGeminiGenerateContentTurnDigest([{ role: 'model', parts: [{ text: 'answer' }] }]);

type NativeProtocol = 'anthropicMessages' | 'openaiChatCompletions' | 'openaiResponses';
const nativeTurn = (target: NativeProtocol, text = 'restored'): AssistantTurnFor<NativeProtocol> => target === 'openaiChatCompletions'
  ? { role: 'assistant', content: text }
  : target === 'anthropicMessages'
    ? { role: 'assistant', content: [{ type: 'text', text, citations: [] }] }
    : [{ type: 'message', role: 'assistant', content: text }];

const cases = [
  { source: 'openaiChatCompletions', target: 'anthropicMessages', run: (carrier: string) => routeOpenAIChatCompletions(chat(carrier)).viaAnthropicMessages(context) },
  { source: 'openaiChatCompletions', target: 'openaiResponses', run: (carrier: string) => routeOpenAIChatCompletions(chat(carrier)).viaOpenAIResponses(context) },
  { source: 'anthropicMessages', target: 'openaiChatCompletions', run: (carrier: string) => routeAnthropicMessages(messages(carrier)).viaOpenAIChatCompletions(context) },
  { source: 'anthropicMessages', target: 'openaiResponses', run: (carrier: string) => routeAnthropicMessages(messages(carrier)).viaOpenAIResponses(context) },
  { source: 'openaiResponses', target: 'anthropicMessages', run: (carrier: string) => routeOpenAIResponses(responses(carrier)).viaAnthropicMessages(context) },
  { source: 'openaiResponses', target: 'openaiChatCompletions', run: (carrier: string) => routeOpenAIResponses(responses(carrier)).viaOpenAIChatCompletions(context) },
  { source: 'geminiGenerateContent', target: 'anthropicMessages', run: (carrier: string) => routeGeminiGenerateContent(gemini(carrier)).viaAnthropicMessages(context) },
  { source: 'geminiGenerateContent', target: 'openaiChatCompletions', run: (carrier: string) => routeGeminiGenerateContent(gemini(carrier)).viaOpenAIChatCompletions(context) },
  { source: 'geminiGenerateContent', target: 'openaiResponses', run: (carrier: string) => routeGeminiGenerateContent(gemini(carrier)).viaOpenAIResponses(context) },
] as const;

test.each(cases)('receives recognized $source history via $target', async ({ source, target, run }) => {
  const native = nativeTurn(target);
  const carrier = await encodeRoundTripSidecar(createTestSidecarCodec(), { v: 1, source, target, targetTurn: native, sourceTurnDigest: await turnDigest(source) });
  const trip = await run(carrier);
  expect('input' in trip.target ? trip.target.input : trip.target.messages).toEqual(target === 'openaiResponses' ? native : [native]);
});

test.each(cases)('hydrates $source text references before restoring $target history', async ({ source, target, run }) => {
  const reference = new ContentReference('text', [[0, 0, 3]]);
  const targetTurn: ReferenceableAssistantTurnFor<NativeProtocol, ContentReference> = target === 'openaiChatCompletions'
    ? { role: 'assistant', content: reference }
    : target === 'anthropicMessages'
      ? { role: 'assistant', content: [{ type: 'text', text: reference, citations: [] }] }
      : [{ type: 'message', role: 'assistant', content: reference }];
  const carrier = await encodeRoundTripSidecar(createTestSidecarCodec(), {
    v: 1, source, target, targetTurn, referencedContentHashes: [await hashRoundTripContent('answer')], sourceTurnDigest: await turnDigest(source),
  });
  const trip = await run(carrier);
  const native = nativeTurn(target, 'ans');
  expect('input' in trip.target ? trip.target.input : trip.target.messages).toEqual(target === 'openaiResponses' ? native : [native]);
});

test('hydrates a native JSON field from a replayed GenerateContent argument candidate', async () => {
  const args = { x: 1 };
  const reference = new ContentReference('json', [0]);
  const targetTurn: ReferenceableAssistantTurnFor<'anthropicMessages', ContentReference> = { role: 'assistant', content: [{ type: 'tool_use', id: 'native-call', name: 'native-tool', input: reference }] };
  const checkMaterial = { contents: [{ inlineData: [], functionCall: [{ name: 'lookup', args }] }] };
  const carrier = await encodeRoundTripSidecar(createTestSidecarCodec(), {
    v: 1,
    source: 'geminiGenerateContent',
    target: 'anthropicMessages', targetTurn,
    referencedContentHashes: [await hashRoundTripContent(JSON.stringify(args))],
    sourceTurnDigest: await hashRoundTripContent(JSON.stringify(checkMaterial)),
  });
  const trip = await routeGeminiGenerateContent({ contents: [{ role: 'model', parts: [{ functionCall: { name: 'lookup', args }, thoughtSignature: carrier }] }] }).viaAnthropicMessages(context);
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
  await expect(cases[0].run(carrier)).rejects.toThrow('Authenticated assistant-turn sidecar restoration failed: missing-reference');
});

test.each(cases)('leaves a terminal sidecar unrecognized by the injected decoder ordinary on $source via $target', async ({ run }) => {
  const carrier = 'unrecognized sidecar handle';
  const trip = await run(carrier);
  expect(JSON.stringify('input' in trip.target ? trip.target.input : trip.target.messages)).toContain('answer');
});

test.each(['different codec scope', 'changed sidecar handle', 'changed replay'] as const)('uses ordinary translation for %s', async failure => {
  const codec = createTestSidecarCodec(failure === 'different codec scope' ? 'other-scope' : 'test-codec-scope');
  const native: AssistantTurnFor<'anthropicMessages'> = { role: 'assistant', content: [{ type: 'text', text: 'restored', citations: [] }] };
  const encoded = await encodeRoundTripSidecar(codec, { v: 1, source: 'openaiChatCompletions', target: 'anthropicMessages', targetTurn: native, sourceTurnDigest: await turnDigest('openaiChatCompletions') });
  const carrier = failure === 'changed sidecar handle' ? `${encoded.startsWith('A') ? 'B' : 'A'}${encoded.slice(1)}` : encoded;
  const text = failure === 'changed replay' ? 'edited' : 'answer';
  const trip = await routeOpenAIChatCompletions(chat(carrier, text)).viaAnthropicMessages(context);
  expect(trip.target.messages).toEqual([{ role: 'assistant', content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] }]);
});

test.each([{ input: 'text' }, { input: null }, { input: [1] }])('preserves ordinary Messages tool input $input', async ({ input }) => {
  const payload: AnthropicMessagesPayload = {
    model: 'source', max_tokens: 16,
    messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'echo', input }] }],
  };
  const chatTrip = await routeAnthropicMessages(payload).viaOpenAIChatCompletions(context);
  expect(chatTrip.target.messages).toMatchObject([
    { role: 'assistant', tool_calls: [{ id: 'call', function: { name: 'echo', arguments: JSON.stringify(input) } }] },
  ]);
  const responsesTrip = await routeAnthropicMessages(payload).viaOpenAIResponses(context);
  expect(responsesTrip.target.input).toMatchObject([
    { type: 'function_call', call_id: 'call', name: 'echo', arguments: JSON.stringify(input) },
  ]);
});

test('preserves ordinary GenerateContent null-argument handling', async () => {
  const payload: GeminiGenerateContentPayload = JSON.parse('{"contents":[{"role":"model","parts":[{"functionCall":{"name":"lookup","args":null}}]}]}');
  const chatTrip = await routeGeminiGenerateContent(payload).viaOpenAIChatCompletions(context);
  expect(chatTrip.target.messages).toMatchObject([
    { role: 'assistant', tool_calls: [{ function: { name: 'lookup', arguments: 'null' } }] },
  ]);
  const responsesTrip = await routeGeminiGenerateContent(payload).viaOpenAIResponses(context);
  expect(responsesTrip.target.input).toMatchObject([
    { type: 'function_call', name: 'lookup', arguments: 'null' },
  ]);
  const messagesTrip = await routeGeminiGenerateContent(payload).viaAnthropicMessages(context);
  expect(messagesTrip.target.messages).toMatchObject([
    { role: 'assistant', content: [{ type: 'tool_use', name: 'lookup', input: null }] },
  ]);
});

test('exposes a recognized malformed assistant envelope as an internal error', async () => {
  // Deliberately bypass the typed encoder to exercise authenticated envelope validation.
  const carrier = await createTestSidecarCodec().encode({
    v: 1,
    source: 'openaiChatCompletions',
    target: 'anthropicMessages',
    targetTurn: { role: 'user', content: [] },
    sourceTurnDigest: await turnDigest('openaiChatCompletions'),
  });
  await expect(routeOpenAIChatCompletions(chat(carrier)).viaAnthropicMessages(context)).rejects.toThrow('Messages assistant turn is invalid');
});

test('accepts incomplete Responses call history and requires its replayed status to match', async () => {
  const call = { type: 'function_call' as const, call_id: 'call', name: 'lookup', arguments: '{"x":1}', status: 'incomplete' };
  const expected = replayMaterialsByType<IRJSONObject & { type: string }>([
    { type: call.type, status: call.status, call_id: call.call_id, name: call.name, arguments: call.arguments },
  ]);
  const native: AssistantTurnFor<'anthropicMessages'> = { role: 'assistant', content: [{ type: 'text', text: 'restored', citations: [] }] };
  const carrier = await encodeRoundTripSidecar(createTestSidecarCodec(), {
    v: 1,
    source: 'openaiResponses',
    target: 'anthropicMessages', targetTurn: native,
    sourceTurnDigest: await hashRoundTripContent(JSON.stringify(expected)),
  });
  const reasoning = { type: 'reasoning' as const, id: 'carrier', summary: [], encrypted_content: carrier };
  const replayed = await routeOpenAIResponses({ model: 'source', input: [call, reasoning] }).viaAnthropicMessages(context);
  expect(replayed.target.messages).toEqual([native]);
  const changed = await routeOpenAIResponses({ model: 'source', input: [{ ...call, status: 'completed' }, reasoning] }).viaAnthropicMessages(context);
  expect(changed.target.messages).not.toEqual([native]);
  expect(changed.target.messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ content: expect.arrayContaining([expect.objectContaining({ type: 'tool_use', id: 'call', name: 'lookup', input: { x: 1 } })]) }),
  ]));
});
