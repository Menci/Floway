import { expect, test } from 'vitest';

import { computeGeminiGenerateContentTurnDigest } from '../../../src/protocols/gemini-generate-content/as-source/round-trip.ts';
import { encodeRoundTripSidecar } from '../../../src/round-trip/sidecar.ts';
import { createTestSidecarCodec } from '../../round-trip/sidecar-codec.ts';
import type { GeminiGenerateContentContent } from '@floway-dev/protocols/gemini-generate-content';
import { routeGeminiGenerateContent } from '@floway-dev/translate/gemini-generate-content';

const targetTurn = (name: string): GeminiGenerateContentContent[] => [{ role: 'model', parts: [{ functionCall: { name, args: { query: 'docs' } } }] }];
const replayedContents = (name: string, carrier: string): GeminiGenerateContentContent[] => [
  { role: 'user', parts: [{ text: 'question' }] },
  { role: 'model', parts: [{ thoughtSignature: carrier, functionCall: { name, args: { query: 'docs' } } }] },
  { role: 'user', parts: [{ functionResponse: { name, response: { answer: 42 } } }] },
  { role: 'model', parts: [{ functionCall: { name: 'other', args: {} } }] },
];

test.each(['lookup', '__proto__'])('Gemini via Chat uses restored call IDs for id-less responses and original indices for later bare calls for %s', async name => {
  const codec = createTestSidecarCodec();
  const native = { role: 'assistant' as const, tool_calls: [{ id: 'native-chat-call', type: 'function' as const, function: { name, arguments: '{"query":"docs"}' } }] };
  const carrier = await encodeRoundTripSidecar(codec, { v: 1, source: 'geminiGenerateContent', target: 'openaiChatCompletions', targetTurn: native, sourceTurnDigest: await computeGeminiGenerateContentTurnDigest(targetTurn(name)) });
  const { target: request } = await routeGeminiGenerateContent({ contents: replayedContents(name, carrier) }).viaOpenAIChatCompletions({ model: 'test', sidecarCodec: createTestSidecarCodec('test-codec-scope') });
  expect(request.messages).toEqual([
    { role: 'user', content: 'question' },
    native,
    { role: 'tool', tool_call_id: 'native-chat-call', content: '{"answer":42}' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'gemini_call_3_0', type: 'function', function: { name: 'other', arguments: '{}' } }] },
  ]);
});

test.each(['lookup', '__proto__'])('Gemini via Messages uses restored call IDs without adding cache metadata to native history for %s', async name => {
  const codec = createTestSidecarCodec();
  const native = { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'native-messages-call', name, input: { query: 'docs' } }] };
  const carrier = await encodeRoundTripSidecar(codec, { v: 1, source: 'geminiGenerateContent', target: 'anthropicMessages', targetTurn: native, sourceTurnDigest: await computeGeminiGenerateContentTurnDigest(targetTurn(name)) });
  const { target: request } = await routeGeminiGenerateContent({ contents: replayedContents(name, carrier) }).viaAnthropicMessages({ model: 'test', sidecarCodec: createTestSidecarCodec('test-codec-scope'), fallbackMaxOutputTokens: undefined });
  expect(request.messages[1]).toEqual(native);
  expect(request.messages[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'native-messages-call', content: '{"answer":42}' }] });
  expect(request.messages[3]).toEqual({ role: 'assistant', content: [{ type: 'tool_use', id: 'gemini_call_3_0', name: 'other', input: {}, cache_control: { type: 'ephemeral' } }] });
});

test.each(['lookup', '__proto__'])('Gemini via Responses uses restored call IDs and preserves later bare call positions for %s', async name => {
  const codec = createTestSidecarCodec();
  const native = [{ type: 'function_call' as const, call_id: 'native-responses-call', name, arguments: '{"query":"docs"}', status: 'completed' as const }];
  const carrier = await encodeRoundTripSidecar(codec, { v: 1, source: 'geminiGenerateContent', target: 'openaiResponses', targetTurn: native, sourceTurnDigest: await computeGeminiGenerateContentTurnDigest(targetTurn(name)) });
  const { target: request } = await routeGeminiGenerateContent({ contents: replayedContents(name, carrier) }).viaOpenAIResponses({ model: 'test', sidecarCodec: createTestSidecarCodec('test-codec-scope') });
  expect(request.input).toEqual([
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] },
    ...native,
    { type: 'function_call_output', call_id: 'native-responses-call', output: '{"answer":42}', status: 'completed' },
    { type: 'function_call', call_id: 'gemini_call_3_0', name: 'other', arguments: '{}', status: 'completed' },
  ]);
});
