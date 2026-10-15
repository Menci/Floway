import { Tag } from 'cbor-x';
import { expect, test } from 'vitest';

import type { IRJSONObject, IRJSONValue } from '../../src/ir/types.ts';
import type { AssistantTurnFor } from '../../src/round-trip/assistant-turn.ts';
import type { RoundTripProtocol } from '../../src/round-trip/codec.ts';
import { hashRoundTripContent, replayMaterialsByType } from '../../src/round-trip/replay-check.ts';
import { THIN_TAGS, type JSONReference, type TextReference, type ThinAssistantTurnFor, type ThinReference } from '../../src/round-trip/thin/assistant-turn.ts';
import { createTestSidecarCodec } from '../round-trip/sidecar-codec.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesRequestPayloadEx } from '@floway-dev/protocols/openai-responses';
import { routeAnthropicMessages } from '@floway-dev/translate/anthropic-messages';
import { routeGeminiGenerateContent } from '@floway-dev/translate/gemini-generate-content';
import { routeOpenAIChatCompletions } from '@floway-dev/translate/openai-chat-completions';
import { routeOpenAIResponses } from '@floway-dev/translate/openai-responses';

const context = { model: 'target', serverSecret: 'test-server-secret', loadRemoteImage: async () => null, fallbackMaxOutputTokens: undefined };
const chat = (carrier: string, text = 'answer'): OpenAIChatCompletionsPayloadEx => {
  const message: OpenAIChatCompletionsAssistantMessageEx = { role: 'assistant', content: text, reasoning_details: [{ type: 'reasoning.encrypted', data: carrier }] };
  return { model: 'source', messages: [message] };
};
const messages = (carrier: string): AnthropicMessagesPayload => ({ model: 'source', max_tokens: 16, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'answer' }, { type: 'redacted_thinking', data: carrier }] }] });
const responses = (carrier: string): OpenAIResponsesRequestPayloadEx => ({ model: 'source', input: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] }, { type: 'reasoning', id: 'carrier', summary: [], encrypted_content: carrier }] });
const gemini = (carrier: string): GeminiGenerateContentPayload => ({ contents: [{ role: 'model', parts: [{ text: 'answer', thoughtSignature: carrier }] }] });

const material = (source: RoundTripProtocol): IRJSONValue => {
  if (source === 'openaiChatCompletions') return { content: 'answer', reasoningText: [], reasoningDetails: [] };
  if (source === 'anthropicMessages') return replayMaterialsByType<IRJSONObject & { type: string }>([{ type: 'text', text: 'answer', citations: [] }]);
  if (source === 'openaiResponses') return replayMaterialsByType<IRJSONObject & { type: string }>([
    { type: 'message', content: replayMaterialsByType<IRJSONObject & { type: string }>([{ type: 'output_text', text: 'answer' }]) },
  ]);
  return { text: ['answer'], inlineData: [], functionCall: [] };
};

const replayCheck = async (source: RoundTripProtocol) => {
  const text = JSON.stringify(material(source));
  if (text === undefined) throw new Error('Fixture replay material is not JSON');
  return { version: 1, digest: await hashRoundTripContent(text) };
};

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

test.each(cases)('receives authenticated $source history via $target', async ({ source, target, run }) => {
  const native = nativeTurn(target);
  const carrier = await createTestSidecarCodec().encode(source, { target, assistantTurn: native, replayCheck: await replayCheck(source) });
  const trip = await run(carrier);
  expect('input' in trip.target ? trip.target.input : trip.target.messages).toEqual(target === 'openaiResponses' ? native : [native]);
});

test.each(cases)('hydrates $source text references before restoring $target history', async ({ source, target, run }) => {
  const reference = new Tag([[0, 0, 3]], THIN_TAGS.text) as TextReference;
  const assistantTurn: ThinAssistantTurnFor<NativeProtocol, ThinReference> = target === 'openaiChatCompletions'
    ? { role: 'assistant', content: reference }
    : target === 'anthropicMessages'
      ? { role: 'assistant', content: [{ type: 'text', text: reference, citations: [] }] }
      : [{ type: 'message', role: 'assistant', content: reference }];
  const carrier = await createTestSidecarCodec().encode(source, {
    target, assistantTurn, referencedContents: [await hashRoundTripContent('answer')], replayCheck: await replayCheck(source),
  });
  const trip = await run(carrier);
  const native = nativeTurn(target, 'ans');
  expect('input' in trip.target ? trip.target.input : trip.target.messages).toEqual(target === 'openaiResponses' ? native : [native]);
});

test('hydrates a native JSON field from a replayed GenerateContent argument candidate', async () => {
  const args = { x: 1 };
  const reference = new Tag([0], THIN_TAGS.json) as JSONReference;
  const assistantTurn: ThinAssistantTurnFor<'anthropicMessages', ThinReference> = { role: 'assistant', content: [{ type: 'tool_use', id: 'native-call', name: 'native-tool', input: reference }] };
  const checkMaterial = { text: [], inlineData: [], functionCall: [{ name: 'lookup', args }] };
  const carrier = await createTestSidecarCodec().encode('geminiGenerateContent', {
    target: 'anthropicMessages', assistantTurn,
    referencedContents: [await hashRoundTripContent(JSON.stringify(args))],
    replayCheck: { version: 1, digest: await hashRoundTripContent(JSON.stringify(checkMaterial)) },
  });
  const trip = await routeGeminiGenerateContent({ contents: [{ role: 'model', parts: [{ functionCall: { name: 'lookup', args }, thoughtSignature: carrier }] }] }).viaAnthropicMessages(context);
  expect(trip.target.messages).toEqual([{ role: 'assistant', content: [{ type: 'tool_use', id: 'native-call', name: 'native-tool', input: args }] }]);
});

test('exposes an authenticated missing reference as an internal error after replay verification', async () => {
  const carrier = await createTestSidecarCodec().encode('openaiChatCompletions', {
    target: 'anthropicMessages',
    assistantTurn: { role: 'assistant', content: [{ type: 'text', text: new Tag([0], THIN_TAGS.text) as TextReference, citations: [] }] },
    referencedContents: [await hashRoundTripContent('missing')],
    replayCheck: await replayCheck('openaiChatCompletions'),
  });
  await expect(cases[0].run(carrier)).rejects.toThrow('Authenticated assistant-turn sidecar hydration failed: missing-reference');
});

test.each(['wrong secret', 'tampered signature', 'changed replay'] as const)('uses ordinary translation for %s', async failure => {
  const codec = createTestSidecarCodec(failure === 'wrong secret' ? 'other-secret' : context.serverSecret);
  const native: AssistantTurnFor<'anthropicMessages'> = { role: 'assistant', content: [{ type: 'text', text: 'restored', citations: [] }] };
  const signed = await codec.encode('openaiChatCompletions', { target: 'anthropicMessages', assistantTurn: native, replayCheck: await replayCheck('openaiChatCompletions') });
  const carrier = failure === 'tampered signature' ? `${signed.startsWith('A') ? 'B' : 'A'}${signed.slice(1)}` : signed;
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

test('exposes an authenticated malformed assistant envelope as an internal error', async () => {
  const carrier = await createTestSidecarCodec().encode('openaiChatCompletions', {
    target: 'anthropicMessages',
    // @ts-expect-error A signed non-assistant envelope is an internal bug.
    assistantTurn: { role: 'user', content: [] },
    replayCheck: await replayCheck('openaiChatCompletions'),
  });
  await expect(routeOpenAIChatCompletions(chat(carrier)).viaAnthropicMessages(context)).rejects.toThrow('Messages assistant turn is invalid');
});

test('accepts incomplete Responses call history and requires its replayed status to match', async () => {
  const call = { type: 'function_call' as const, call_id: 'call', name: 'lookup', arguments: '{"x":1}', status: 'incomplete' };
  const expected = replayMaterialsByType<IRJSONObject & { type: string }>([
    { type: call.type, status: call.status, call_id: call.call_id, name: call.name, arguments: call.arguments },
  ]);
  const native: AssistantTurnFor<'anthropicMessages'> = { role: 'assistant', content: [{ type: 'text', text: 'restored', citations: [] }] };
  const carrier = await createTestSidecarCodec().encode('openaiResponses', {
    target: 'anthropicMessages', assistantTurn: native,
    replayCheck: { version: 1, digest: await hashRoundTripContent(JSON.stringify(expected)) },
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
